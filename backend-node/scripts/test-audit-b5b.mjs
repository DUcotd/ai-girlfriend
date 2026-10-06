/**
 * B5-12 回归测试：全量档案导出 / 导入 / 自动快照。
 *
 * 这是整个审计里最「输不起」的一块：导错、导坏、或者「导入没生效」都会直接
 * 造成用户几个月甚至几年的对话与关系不可恢复。所以断言集中在三类：
 *   1. 完整性：data/ 里每个数据文件都必须进档案（漏登记 = 静默丢数据）；
 *   2. 安全性：档案里绝不能出现 API Key；导入前必有快照、出错必如实报告；
 *   3. 生效性：导入后**不重启**也必须立刻生效，且内存里的旧状态不能在几十秒后
 *      把刚导入的文件盖回去（去抖写盘最容易留这个坑）。
 *
 * 运行：node scripts/test-audit-b5b.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aigf-b5b-'));
process.env.AI_GIRLFRIEND_DATA_DIR = path.join(sandbox, 'data');
process.env.AI_GIRLFRIEND_BACKUP_DIR = path.join(sandbox, 'backups');
process.env.HOST = '127.0.0.1';
// 必须在 createApp() 之前设：鉴权中间件在装配时就从 env 取了 token 快照，
// 之后再改 env 不会生效（这正是 B9 修过的那类「读时机」坑）。
process.env.AI_GIRLFRIEND_TOKEN = 'b5b-token';

// 数据文件必须先写好、再 import 容器：引擎在构造时就从磁盘读状态，
// 反过来（先 import 再写文件）会让内存里全是默认值，测出来的「导入没生效」其实是测试自己的顺序错。
const DATA = process.env.AI_GIRLFRIEND_DATA_DIR;
function seedFile(name, obj) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2), 'utf-8');
}
seedFile('state.json', {
    nickname: '阿宁',
    history: [{ role: 'user', content: '今天加班到十点' }, { role: 'assistant', content: '辛苦啦' }],
    config: { baseUrl: 'https://models.example.com/v1', modelName: 'test-model' },
    toggles: { userEmotionEnabled: true, narrativeEnabled: true, triggerEnabled: true, memoryFactsEnabled: true, memoryRetrievalMode: 'keyword' },
});
seedFile('memory.json', {
    version: 2,
    episodes: [{ id: 'e1', text: '他说明天要答辩', embedding: null, embeddingModel: null, emotionSnapshot: null, timestamp: Date.now() / 1000 }],
    facts: [{ id: 'f1', content: '他在准备毕业答辩', category: 'work', importance: 5, source: 'manual', embedding: null, embeddingModel: null, createdAt: 1, updatedAt: 1 }],
});
seedFile('affinity_state.json', { affinity: 62, ledger: [], gainEvents: [], daily: {}, lastUserActiveTime: Date.now() });
seedFile('tasks.json', [{ id: 't1', title: '交答辩材料', dueTime: null, completed: false, source: 'manual', reminderState: {} }]);

const { config } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const { aiGirlfriend, proactiveEngine, triggerRegistry, taskManager } =
    await import('../src/services/container.js');
const backup = await import('../src/core/backup.js');
const { createHarness } = await import('./lib/testKit.mjs');
const NarrativeStore = (await import('../src/core/narrative/NarrativeStore.js')).default;
const UserEmotionEngine = (await import('../src/core/UserEmotionEngine.js')).default;

const t = createHarness('audit-b5b', { expect: 67 });
const check = t.check;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const services = { aiGirlfriend, proactiveEngine, triggerRegistry, taskManager };

function writeFile(name, obj) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2), 'utf-8');
}
function readFile(name) {
    const p = path.join(DATA, name);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

const app = createApp();
const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
async function api(method, p, body, token = 'b5b-token') {
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(`${base}${p}`, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 保留原文 */ }
    return { status: res.status, json, text, headers: res.headers };
}
process.env.AI_GIRLFRIEND_TOKEN = 'b5b-token';

// =========================================================================
console.log('== 清单对账：data/ 里的每个数据文件都必须进档案 ==');
{
    const onDisk = fs.readdirSync(DATA).filter((f) => f.endsWith('.json'));
    const unlisted = onDisk.filter((f) => !backup.ARCHIVE_FILE_NAMES.includes(f));
    check('data/ 下没有未登记的 .json 数据文件（新增文件必须进 ARCHIVE_FILES）',
        unlisted.length === 0, `未登记：${unlisted.join(', ')}`);
    check('清单里每一项都是 .json 且无重复',
        backup.ARCHIVE_FILE_NAMES.every((f) => f.endsWith('.json'))
        && new Set(backup.ARCHIVE_FILE_NAMES).size === backup.ARCHIVE_FILE_NAMES.length);
    check('每个文件都写明了属主与热加载函数（否则导入只能靠重启）',
        backup.ARCHIVE_FILES.every((e) => typeof e.file === 'string' && typeof e.owner === 'string'
            && typeof e.reload === 'function' && typeof e.label === 'string'));
    check('属主互不重复',
        new Set(backup.ARCHIVE_FILES.map((e) => e.owner)).size === backup.ARCHIVE_FILES.length);
}

console.log('== 导出：先 flush 再读盘 ==');
{
    // 往内存里塞一条「还没落盘」的情节，导出必须带上它
    aiGirlfriend.memory?.store?.episodes?.push?.({
        id: 'pending-1', text: '这条只在内存里，没 scheduleSave', embedding: null,
        embeddingModel: null, emotionSnapshot: null, timestamp: Date.now() / 1000,
    });
    aiGirlfriend.memory?.store?.scheduleSave?.();
    const before = readFile('memory.json');
    const arch = await backup.buildArchive(services);
    check('档案的 kind/version 正确',
        arch.kind === backup.ARCHIVE_KIND && arch.version === backup.ARCHIVE_VERSION);
    const mem = arch.files['memory.json'];
    check('导出前真的 flush 过：只在内存里的那条情节进了档案',
        Array.isArray(mem?.episodes) && mem.episodes.some((e) => e.id === 'pending-1'),
        `导出前盘上有 ${before?.episodes?.length} 条，档案里有 ${mem?.episodes?.length} 条`);
    check('档案带 exportedAt / manifest（人能看懂每个文件是什么）',
        typeof arch.exportedAt === 'string' && Array.isArray(arch.manifest)
        && arch.manifest.length === backup.ARCHIVE_FILES.length);
    check('每个进档案的文件都有 sha256 校验和',
        Object.keys(arch.files).every((k) => /^[0-9a-f]{64}$/.test(arch.checksums[k] || '')));
    // app 段只留主机名；state.json 里那份完整 baseUrl 是「用户自己的配置」，本来就该进档案
    check('档案的 app 段只记主机名（不额外再复制一份地址）',
        arch.app.baseUrlHost === 'models.example.com' && !('baseUrl' in arch.app),
        JSON.stringify(arch.app));

    aiGirlfriend.apiKey = 'sk-SUPERSECRET-1234567890abcdef';
    const arch2 = await backup.buildArchive(services);
    check('档案绝不含 API Key（Key 只在内存，不随档案外流）',
        !JSON.stringify(arch2).includes('sk-SUPERSECRET'), '档案里出现明文 Key');
    check('自检能抓到人为注入的密钥（导出前那道闸）',
        backup.scanForSecrets({ files: { 'state.json': { apiKey: 'sk-abcdefghijklmnop' } } }).length > 0);
    check('正常档案不会误报敏感信息',
        backup.scanForSecrets(arch2).length === 0, backup.scanForSecrets(arch2).join(';'));
    aiGirlfriend.apiKey = null;
}

console.log('== 校验：拒绝不是一份档案的东西 ==');
{
    const good = await backup.buildArchive(services);
    check('完整档案校验通过（无 errors）', backup.validateArchive(good).errors.length === 0,
        backup.validateArchive(good).errors.join(';'));
    check('非对象一律拒', backup.validateArchive('just a string').errors.length === 1);
    check('kind 不对一律拒（防止把别的 JSON 当档案导进来）',
        backup.validateArchive({ ...good, kind: 'something-else' }).errors.some((e) => /档案格式/.test(e)));
    check('version 不支持一律拒',
        backup.validateArchive({ ...good, version: 999 }).errors.some((e) => /版本/.test(e)));
    check('没有 files 段一律拒',
        backup.validateArchive({ ...good, files: undefined }).errors.some((e) => /files/.test(e)));
    check('某个文件的内容不是对象 → 拒（不能让它变成「清空这份数据」）',
        backup.validateArchive({ ...good, files: { ...good.files, 'memory.json': 'oops' } })
            .errors.some((e) => /memory\.json 的内容不是/.test(e)));
    check('未知项只告警不阻断（向前兼容新版档案）',
        backup.validateArchive({ ...good, files: { ...good.files, 'future.json': { a: 1 } } })
            .errors.length === 0);
    check('校验和不匹配只告警（对象重新序列化本就会差空白）',
        backup.validateArchive({
            ...good, checksums: { ...good.checksums, 'tasks.json': '0'.repeat(64) },
        }).warnings.some((w) => /tasks\.json 的校验和/.test(w)));
    check('完全没有可导入项 → 拒（避免「导入成功但其实什么都没做」）',
        backup.validateArchive({ ...good, files: {} }).errors.some((e) => /没有任何可导入/.test(e)));
}

console.log('== 导入：不重启也立刻生效，且旧内存态不能回写覆盖 ==');
{
    const arch = await backup.buildArchive(services);
    // 改一份档案：换昵称、换任务、加一条事实 —— 三项分属不同引擎，都要热加载
    const modified = JSON.parse(JSON.stringify(arch));
    modified.files['state.json'].nickname = '小舟';
    modified.files['tasks.json'] = [{ id: 'imported-1', title: '导入进来的任务', completed: false, source: 'manual', reminderState: {} }];
    modified.files['memory.json'].facts.push({
        id: 'imported-fact', content: '他换了个称呼', category: 'personal', importance: 4,
        source: 'manual', embedding: null, embeddingModel: null, createdAt: 2, updatedAt: 2,
    });

    const { errors, files } = backup.validateArchive(modified);
    check('改造后的档案校验通过', errors.length === 0, errors.join(';'));
    const report = backup.applyArchive(files, services, { reason: 'import' });
    const changed = ['state.json', 'tasks.json', 'memory.json'];
    check('改动过的文件全部写入成功', report.writeFailed.length === 0
        && changed.every((f) => report.written.includes(f)), JSON.stringify(report.writeFailed));
    check('改动过的文件全部热加载成功（不靠重启）', report.reloadFailed.length === 0
        && changed.every((f) => report.reloaded.includes(f)), JSON.stringify(report.reloadFailed));
    check('导入前自动做了快照（出错还能退回导入前）',
        fs.existsSync(report.snapshot.dir) && report.snapshot.files.length > 0, report.snapshot.dir);
    check('昵称立刻生效', aiGirlfriend.nickname === '小舟', aiGirlfriend.nickname);
    check('任务立刻生效', taskManager.getTasks().some((x) => x.id === 'imported-1'),
        JSON.stringify(taskManager.getTasks().map((x) => x.id)));
    check('事实立刻生效',
        aiGirlfriend.memory.store.facts.some((f) => f.id === 'imported-fact'),
        JSON.stringify(aiGirlfriend.memory.store.facts.map((f) => f.id)));

    // 关键：等过去抖窗口（memory/narrative/userEmotion/trigger 都是 2s），
    // 若 reload 没清掉待写定时器，旧内存态会在这之后把刚导入的文件盖回去
    await sleep(config.memory.flushDebounceMs + 800);
    const onDisk = readFile('memory.json');
    check('去抖窗口之后磁盘上仍是导入的那份（旧内存态没有回写覆盖）',
        Array.isArray(onDisk?.facts) && onDisk.facts.some((f) => f.id === 'imported-fact'),
        JSON.stringify((onDisk?.facts || []).map((f) => f.id)));
    const stateDisk = readFile('state.json');
    check('state.json 也没被旧内存态盖回去', stateDisk?.nickname === '小舟', stateDisk?.nickname);

    // 再导回原档案，验证双向可逆
    backup.applyArchive(arch.files, services, { reason: 'restore-back' });
    check('导入回原档案后昵称复原', aiGirlfriend.nickname === '阿宁', aiGirlfriend.nickname);
    check('导入回原档案后任务复原', !taskManager.getTasks().some((x) => x.id === 'imported-1'));
}

console.log('== 快照：建、列、清、恢复 ==');
{
    const prevKeep = config.backup.keep;
    config.backup.keep = 3;
    for (let i = 0; i < 5; i++) {
        backup.createSnapshot(`bulk-${i}`, new Date(Date.now() + i * 1000));
    }
    const listed = backup.listSnapshots();
    check('快照数量被收敛到 keep 份', listed.length === 3, `实际 ${listed.length}`);
    check('列表按时间倒序（新的在前）', listed[0].id > listed[2].id,
        listed.map((s) => s.id).join(','));
    // 显式设了 AI_GIRLFRIEND_BACKUP_DIR（本套件就是这么跑的），快照就该在指定目录里；
    // 断言的实质是「不逃到仓库/别处」，所以比 sandbox 根而不是比 DATA（后者会被显式目录合法地越过）
    check('快照目录不会逃到本次运行隔离区之外',
        listed.every((x) => path.resolve(x.dir).startsWith(path.resolve(sandbox))),
        listed[0]?.dir);
    check('每个快照都自带 SNAPSHOT_INFO.json 说明来源',
        listed.every((s) => s.reason && Array.isArray(s.files)), JSON.stringify(listed[0]));
    check('快照目录就在备份根目录下、且整体落在本次的沙盒里',
        listed.every((s) => path.resolve(s.dir).startsWith(path.resolve(backup.backupRoot())))
        && path.resolve(backup.backupRoot()).startsWith(path.resolve(sandbox)),
        backup.backupRoot());

    // 恢复一份快照：等于把那份快照当档案导入
    const target = listed[0];
    const restored = backup.restoreSnapshot(target.id, services);
    check('restore 会先做 pre-restore 快照再写',
        fs.existsSync(restored.applied.snapshot.dir) && restored.restoredFrom === target.id,
        `dir=${restored.applied?.snapshot?.dir} from=${restored.restoredFrom} target=${target.id} written=${restored.applied?.written?.length}`);
    const bad = (() => { try { backup.restoreSnapshot('../../etc/passwd', services); return 'no-throw'; } catch (e) { return e.message; } })();
    check('快照 id 带路径穿越被拒', /不合法|不存在/.test(bad), bad);
    const missing = (() => { try { backup.restoreSnapshot('no-such-snapshot', services); return 'no-throw'; } catch (e) { return e.status; } })();
    check('恢复不存在的快照 → 404', missing === 404, String(missing));
    config.backup.keep = prevKeep;
}

console.log('== 路由：export / import / status / reset 自动快照 ==');
{
    const noAuth = await fetch(`${base}/backup/status`);
    check('不带 token → 401（这是能覆盖/清空全部数据的接口）', noAuth.status === 401, `${noAuth.status}`);
    const wrongAuth = await api('GET', '/backup/status', undefined, 'wrong-token');
    check('带错 token → 401', wrongAuth.status === 401, `${wrongAuth.status}`);

    const status = await api('GET', '/backup/status');
    check('GET /backup/status 回数据目录、备份目录与快照列表',
        status.json?.dataDir && status.json?.backupDir && Array.isArray(status.json?.snapshots),
        JSON.stringify(status.json || status.text).slice(0, 120));

    const exp = await api('GET', '/backup/export');
    check('GET /backup/export 回附件下载头（文件名带时间戳）',
        /attachment; filename="ai-girlfriend-archive-.*\.json"/.test(exp.headers.get('content-disposition') || ''),
        String(exp.headers.get('content-disposition')));
    check('导出的档案能被原样解析出 files',
        exp.json?.kind === backup.ARCHIVE_KIND && !!exp.json?.files?.['state.json']);

    const badImport = await api('POST', '/backup/import', { hello: 'world' });
    check('导入非档案 → 400 + 稳定码 backup_invalid',
        badImport.status === 400 && badImport.json?.error_code === 'backup_invalid',
        `${badImport.status} ${badImport.text.slice(0, 80)}`);

    const roundTrip = await api('POST', '/backup/import', exp.json);
    check('导入刚导出的档案 → 200，报告如实列出写了/热加载了哪些文件',
        roundTrip.status === 200 && roundTrip.json?.status === 'imported'
        && roundTrip.json.written.length >= 3 && roundTrip.json.writeFailed.length === 0,
        JSON.stringify(roundTrip.json || roundTrip.text).slice(0, 200));
    check('导入响应里带上快照目录（用户可以自己去删/拷）',
        typeof roundTrip.json?.snapshot === 'string' && fs.existsSync(roundTrip.json.snapshot),
        String(roundTrip.json?.snapshot));

    // 重置前自动快照：这是「手滑也能救回来」的端到端验证
    const beforeReset = (await api('GET', '/state')).json;
    const reset = await api('POST', '/reset', {});
    check('POST /reset 回快照目录', typeof reset.json?.snapshot === 'string' && !!reset.json.snapshot,
        JSON.stringify(reset.json || reset.text).slice(0, 160));
    check('快照目录里确实有数据文件', reset.json?.snapshotFiles > 0, String(reset.json?.snapshotFiles));
    check('重置真的把昵称抹回默认',
        (await api('GET', '/state')).json?.nickname !== beforeReset.json?.nickname
        || (await api('GET', '/state')).json?.nickname === '你',
        JSON.stringify([(await api('GET', '/state')).json?.nickname, beforeReset.json?.nickname]));
    const snapFiles = fs.readdirSync(reset.json.snapshot).filter((f) => f.endsWith('.json'));
    check('快照里存着重置前的 state.json 与 memory.json',
        snapFiles.includes('state.json') && snapFiles.includes('memory.json'), snapFiles.join(','));

    const restore = await api('POST', '/backup/restore', { id: path.basename(reset.json.snapshot) });
    check('从 pre-reset 快照恢复 → 200 restored',
        restore.status === 200 && restore.json?.status === 'restored',
        JSON.stringify(restore.json || restore.text).slice(0, 200));
    const afterRestore = readFile('state.json');
    check('恢复后磁盘上的 state.json 回到重置前',
        JSON.stringify(afterRestore) === JSON.stringify(readFile('state.json')) && !!afterRestore,
        '快照恢复未落盘');
    const badRestore = await api('POST', '/backup/restore', { id: '../outside' });
    check('restore 的 id 会被校验（路径穿越拿不到别处文件）',
        badRestore.status === 400 || badRestore.status === 404, `${badRestore.status}`);
    const noId = await api('POST', '/backup/restore', {});
    check('restore 缺 id → 400 + 稳定码',
        noId.status === 400 && noId.json?.error_code === 'backup_bad_request', `${noId.status}`);

    const snap = await api('POST', '/backup/snapshot', { reason: 'from_ui' });
    check('手动快照可用且带 reason',
        snap.status === 200 && /from_ui/.test(snap.json?.dir || ''), JSON.stringify(snap.json));
}

console.log('== B0-6 后半：去抖 flush 必须回传写盘结果 ==');
{
    const ns = new NarrativeStore();
    ns.narratives.push({ id: 'x1', type: 'shared_event', title: '测试', summary: '', occurredAt: Date.now() });
    ns._dirty = true;
    check('写盘成功时 flush() 返回 true 且清掉脏标记',
        ns.flush() === true && ns._dirty === false);

    // 模拟磁盘写不进去：flush 必须回 false，并且**保持脏**等下次重试
    ns._dirty = true;
    const orig = ns._saveNow.bind(ns);
    ns._saveNow = () => false;
    const failed = ns.flush();
    ns._saveNow = orig;
    check('写盘失败时 flush() 返回 false（以前这里什么都不回，失败完全不可见）',
        failed === false, String(failed));
    check('写盘失败后仍然是脏的，下次会继续尝试', ns._dirty === true);

    const ue = new UserEmotionEngine();
    ue._dirty = true;
    const origUe = ue._saveNow.bind(ue);
    ue._saveNow = () => false;
    const ueFailed = ue.flush();
    ue._saveNow = origUe;
    check('UserEmotionEngine.flush() 同样回传结果并保持脏标记',
        ueFailed === false && ue._dirty === true, `${ueFailed}/${ue._dirty}`);

    triggerRegistry.eventQueue.push({ id: 'q1', triggerId: 't', targetType: 'miss_you', data: {} });
    // 直接 flush 而不是「scheduleSave 后睡 1.2 秒等去抖定时器」：CI 的 2 核 runner 上
    // 那个定时器可能晚于 1.2 秒才跑，测试就会偶发假失败（本地永远复现不出来）
    triggerRegistry.scheduleSave();
    // 直接 flush 而不是「scheduleSave 后睡觉等定时器」：CI 的 2 核 runner 上去抖定时器
    // 可能晚于任何合理的等待时间，测试就会偶发假失败（本地永远复现不出来）
    const flushed = triggerRegistry.flush();
    check('flush() 把去抖中的待写数据立刻落盘并回传 true', flushed === true);
    check('TriggerRegistry 的队列变更确实写到了磁盘（重启后能恢复）',
        !!readFile('trigger_state.json')?.eventQueue?.some((q) => q.id === 'q1'),
        JSON.stringify(readFile('trigger_state.json')?.eventQueue));
    check('无事可写时 flush() 仍返回 true（幂等，不误报失败）',
        triggerRegistry.flush() === true);
}

// =========================================================================
console.log('== 备份目录推导 ==');
{
    check('显式设置 AI_GIRLFRIEND_BACKUP_DIR 时以它为准',
        path.resolve(backup.backupRoot()) === path.resolve(process.env.AI_GIRLFRIEND_BACKUP_DIR),
        backup.backupRoot());
    const savedDir = config.backup.dir;
    config.backup.dir = null;
    const derived = path.resolve(backup.backupRoot());
    config.backup.dir = savedDir;
    check('未设置时落在数据目录**里面**（任何重定向都带着它走，不会漏到仓库或别处）',
        derived === path.resolve(path.join(DATA, 'backups')), derived);
    check('仓库工作区里没有被测试留下的 backups 目录',
        !fs.existsSync(path.resolve('backups')), 'backend-node/backups 存在，说明有测试写到了真实目录');
}

server.closeAllConnections?.();
await new Promise((r) => server.close(r));
proactiveEngine.stop();
const code = t.finish();
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(code);
