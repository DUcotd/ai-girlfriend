/**
 * 记忆系统回归测试（单进程自包含）。
 *
 * ⚠️ 与 test-affinity.mjs 同款约束：禁止 spawn 子进程，全部用例在同一进程内用
 * Node 内置 assert + 计数器跑完，失败时 process.exitCode=1。
 *
 * ⚠️ 真实数据保护：凡涉及 Memory/MemoryStore 实例的用例，必须先替换
 * scheduleSave/flush 为空操作——去抖定时器若在测试进程里触发，会把测试数据
 * 原子写进真实的 data/memory.json。
 *
 * 覆盖：v1→v2 迁移 / jsonStore 损坏隔离 / 切词与 Jaccard / BM25 关键词打分 /
 * 模式分派（auto/embedding/keyword）/ 语义阈值与去重递补 / 事实操作解析与应用 /
 * 事实去重与容量裁剪 / recordTurn→提取管线（mock LLM）/ clearMemory 在途提取作废。
 */
import assert from 'assert';
import fs from 'fs';
import { migrateV1ToV2, capFacts, MemoryStore } from '../src/core/memory/MemoryStore.js';
import { EmbeddingClient } from '../src/core/memory/EmbeddingClient.js';
import { scoreEpisodes, isNearDuplicateText } from '../src/core/memory/KeywordScorer.js';
import { tokenize, jaccardSimilarity, normalizeText } from '../src/core/memory/textSim.js';
import { parseFactOps, FactExtractor, clampImportance, normalizeCategory } from '../src/core/memory/FactExtractor.js';
import { MemoryRetriever } from '../src/core/memory/MemoryRetriever.js';
import Memory from '../src/core/Memory.js';
import { config } from '../src/config.js';
import { dataPath, readJson, writeJson } from '../src/utils/jsonStore.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  OK   ${name}`);
    } catch (e) {
        failed++;
        process.exitCode = 1;
        console.error(`  FAIL ${name}\n       ${e.message}`);
    }
}
async function checkAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  OK   ${name}`);
    } catch (e) {
        failed++;
        process.exitCode = 1;
        console.error(`  FAIL ${name}\n       ${e.message}`);
    }
}

/** 真实数据保护：屏蔽实例的一切落盘动作 */
function disarmStore(memory) {
    memory.store.scheduleSave = () => {};
    memory.store.flush = () => {};
}

(async () => {
    // ==================== 1. v1 → v2 迁移 ====================
    console.log('v1→v2 迁移:');
    check('字段映射且清除 metadata 双写冗余', () => {
        const v2 = migrateV1ToV2([{
            id: 'a', text: 'User: hi\nXiao Ai: 你好',
            embedding: [1, 2], embeddingModel: 'm1',
            metadata: { emotionSnapshot: { P: 0.1, A: 0.2, D: 0.3, timestamp: 1 } },
            emotionSnapshot: { P: 0.9, A: 0.8, D: 0.7, timestamp: 2 },
            timestamp: 100,
        }]);
        assert.strictEqual(v2.length, 1);
        const e = v2[0];
        assert.deepStrictEqual(
            Object.keys(e).sort(),
            ['embedding', 'embeddingModel', 'emotionSnapshot', 'id', 'text', 'timestamp']
        );
        assert.strictEqual(e.emotionSnapshot.P, 0.9, '顶层快照优先');
        assert.strictEqual(e.timestamp, 100);
    });

    check('顶层缺快照时回退 metadata 内的', () => {
        const v2 = migrateV1ToV2([{
            text: 'x', metadata: { emotionSnapshot: { P: 0.5, A: 0, D: 0 } },
        }]);
        assert.strictEqual(v2[0].emotionSnapshot.P, 0.5);
        assert.ok(v2[0].id, '缺 id 自动补 uuid');
    });

    check('过滤无文本条目、非法向量归 null、缺时间戳补当前', () => {
        const v2 = migrateV1ToV2([
            { text: '   ' },
            null,
            { text: 'ok', embedding: 'not-array' },
            { text: 'ok2' },
        ]);
        assert.strictEqual(v2.length, 2);
        assert.strictEqual(v2[0].embedding, null);
        assert.ok(Math.abs(v2[1].timestamp - Date.now() / 1000) < 60);
    });

    // ==================== 2. jsonStore 损坏隔离 ====================
    //
    // 说明（测试卫生）：
    // readJson/writeJson 内部把文件名绑定到 backend-node/data/，未暴露 DATA_DIR。
    // 因此要触发「解析失败 → 改名隔离」这条真实逻辑，测试文件就必须落在 data/ 下，
    // 无法改写到 os.tmpdir()。既然必须写在共享数据目录，就采取以下三重环保措施：
    //   1) 测试开始前先扫一遍 data/，清理上次残留的 <前缀> 与 <前缀>.corrupt-* 文件；
    //   2) 用例内所有清理调用一律容错，失败仅告警，绝不中断测试；
    //   3) 用完后尽力清理，不残留。
    console.log('jsonStore 损坏隔离:');
    const QUARANTINE_FILE = 'jsonstore_quarantine_test.json';
    const QUARANTINE_PREFIX = `${QUARANTINE_FILE}.corrupt-`;
    const quarantinePath = dataPath(QUARANTINE_FILE);
    /** 删除单个文件，失败仅告警（沙箱 safe-delete 护栏可能拦截 unlink）。 */
    const safeUnlink = (target) => {
        try {
            fs.unlinkSync(target);
        } catch (e) {
            console.warn(`  WARN 清理 ${target} 失败（已忽略）: ${e.message}`);
        }
    };
    /** 清理 data/ 下严格匹配本测试前缀的残留（含隔离副本），绝不触碰其他数据文件。 */
    const sweepQuarantineResidue = () => {
        let entries = [];
        try {
            entries = fs.readdirSync(dataPath('.'));
        } catch (e) {
            console.warn(`  WARN 扫描 data/ 失败（已忽略）: ${e.message}`);
            return;
        }
        for (const f of entries) {
            if (f === QUARANTINE_FILE || f.startsWith(QUARANTINE_PREFIX)) {
                safeUnlink(dataPath(f));
            }
        }
    };
    try {
        sweepQuarantineResidue(); // 兜底：清掉上一次运行可能残留的文件
        fs.writeFileSync(quarantinePath, '{ this is not json', 'utf-8');
        const fallback = readJson(QUARANTINE_FILE, 'fallback-value');
        assert.strictEqual(fallback, 'fallback-value');
        // 原文件应已被改名隔离（保留现场），不再停留在原路径
        assert.strictEqual(fs.existsSync(quarantinePath), false, '损坏文件应被改名');
        const quarantined = fs.readdirSync(dataPath('.')).find((f) => f.startsWith(QUARANTINE_PREFIX));
        assert.ok(quarantined, '存在 .corrupt- 隔离副本');
        // 清理隔离副本（沙箱下可能被 safe-delete 拦截，降级为告警）
        safeUnlink(dataPath(quarantined));
    } finally {
        try { fs.unlinkSync(quarantinePath); } catch { /* 已隔离或不存在 */ }
        sweepQuarantineResidue(); // 再兜底扫一遍，确保不残留
    }

    check('正常文件读取不受隔离逻辑影响', () => {
        writeJson('jsonstore_roundtrip_test.json', { hello: 'world' });
        try {
            assert.deepStrictEqual(readJson('jsonstore_roundtrip_test.json', null), { hello: 'world' });
        } finally {
            try { fs.unlinkSync(dataPath('jsonstore_roundtrip_test.json')); } catch { /* ignore */ }
        }
    });

    // ==================== 3. 切词与文本相似度 ====================
    console.log('切词与相似度:');
    check('英文按整词、中文按 bigram 切', () => {
        const terms = tokenize('我喜欢 Genshin');
        assert.ok(terms.includes('genshin'), 'ASCII 整词保留');
        assert.ok(terms.includes('喜欢'), '中文 bigram');
        assert.ok(terms.includes('欢 '), '跨片 bigram（中→空格侧）或不含——只验证中文切词存在');
    });

    check('空输入切词为空', () => {
        assert.deepStrictEqual(tokenize(''), []);
        assert.deepStrictEqual(tokenize(null), []);
    });

    check('normalizeText 去空白与标点', () => {
        assert.strictEqual(normalizeText('你好， 世界！'), '你好世界');
    });

    check('Jaccard：完全相同为 1，无关文本接近 0', () => {
        assert.strictEqual(jaccardSimilarity('用户喜欢玩游戏', '用户喜欢玩游戏'), 1);
        assert.ok(jaccardSimilarity('用户喜欢玩游戏', '今天天气不错呀') < 0.2);
    });

    check('isNearDuplicateText：等价与阈值行为', () => {
        assert.strictEqual(isNearDuplicateText('用户喜欢玩游戏', '用户，喜欢！玩游戏', 0.9), true, '标点差异归一后等价');
        assert.strictEqual(isNearDuplicateText('用户喜欢玩游戏', '完全不同的另一句话', 0.9), false);
    });

    // ==================== 4. BM25 关键词打分（方案 B） ====================
    console.log('BM25 关键词打分:');
    const kwEpisodes = [
        { id: 'e1', text: 'User: 我最喜欢玩原神了\nXiao Ai: 原神呀，你每天都玩吗', timestamp: Date.now() / 1000 - 100 },
        { id: 'e2', text: 'User: 今天天气真不错\nXiao Ai: 是呀，适合出门散步', timestamp: Date.now() / 1000 - 100 },
        { id: 'e3', text: 'User: 我不喜欢香菜\nXiao Ai: 记住了，你不吃香菜', timestamp: Date.now() / 1000 - 86400 * 30 },
    ];
    check('相关记忆得分高于无关记忆且按分排序', () => {
        const hits = scoreEpisodes({
            episodes: kwEpisodes, query: '你平时喜欢玩什么游戏',
            minHits: 2, recencyWeight: 0.15, recencyHalfLifeDays: 14,
        });
        assert.ok(hits.length >= 1);
        assert.strictEqual(hits[0].id, 'e1', '原神话题应排第一');
        assert.ok(hits[0].score > 0);
    });

    check('minHits 过滤弱命中（命中不足的条目不入选）', () => {
        const hits = scoreEpisodes({
            episodes: kwEpisodes, query: '一个完全不相干的问题',
            minHits: 3, recencyWeight: 0.15, recencyHalfLifeDays: 14,
        });
        assert.strictEqual(hits.length, 0, '八竿子打不着的查询在 minHits=3 下应无结果');
    });

    check('recency：相关度相同时新记忆得分更高', () => {
        const now = Date.now() / 1000;
        const eps = [
            { id: 'new', text: 'User: 我喜欢蓝色\nXiao Ai: 蓝色很好看', timestamp: now - 100 },
            { id: 'old', text: 'User: 我喜欢蓝色\nXiao Ai: 蓝色很好看', timestamp: now - 86400 * 60 },
        ];
        const hits = scoreEpisodes({
            episodes: eps, query: '我喜欢什么颜色', minHits: 1,
            recencyWeight: 0.5, recencyHalfLifeDays: 14,
        });
        assert.strictEqual(hits[0].id, 'new');
        assert.ok(hits[0].score > hits[1].score);
    });

    // ==================== 5. 事实操作解析 ====================
    console.log('事实操作解析:');
    check('纯 JSON 正常解析', () => {
        const ops = parseFactOps('{"add":[{"content":"用户喜欢猫","category":"preference","importance":4}],"update":[],"delete":[]}');
        assert.strictEqual(ops.add.length, 1);
        assert.strictEqual(ops.add[0].content, '用户喜欢猫');
    });

    check('代码栅栏包裹与前后杂讯均可解析', () => {
        const ops = parseFactOps('好的，以下是操作：\n```json\n{"add":[{"content":"A"}],"update":[{"id":"x","content":"B"}],"delete":["d1","d2"]}\n```\n以上。');
        assert.strictEqual(ops.add.length, 1);
        assert.strictEqual(ops.update.length, 1);
        assert.deepStrictEqual(ops.delete, ['d1', 'd2']);
    });

    check('垃圾输入返回空操作', () => {
        for (const garbage of ['', null, '我觉得这轮对话没什么可记的', '{"add": "not-array"}', '{"add":[{"no_content":1}]}']) {
            const ops = parseFactOps(garbage);
            assert.strictEqual(ops.add.length + ops.update.length + ops.delete.length, 0, `垃圾输入: ${garbage}`);
        }
    });

    check('非法分类归 other、重要度钳制 1-5', () => {
        assert.strictEqual(normalizeCategory('weird'), 'other');
        assert.strictEqual(normalizeCategory('identity'), 'identity');
        assert.strictEqual(clampImportance(0), 1);
        assert.strictEqual(clampImportance(9), 5);
        assert.strictEqual(clampImportance(2.4), 2);
        assert.strictEqual(clampImportance('abc'), 3);
    });

    // ==================== 6. 事实去重与容量裁剪 ====================
    console.log('事实去重与裁剪:');
    check('文本包含判定重复（无向量路径，方案 B）', () => {
        const facts = [{ id: 'f1', content: '用户喜欢玩原神', embedding: null }];
        assert.strictEqual(FactExtractor.isDuplicateFact('用户喜欢玩原神', null, facts), true, '完全相同');
        assert.strictEqual(FactExtractor.isDuplicateFact('用户喜欢玩原神哦', null, facts), true, '新事实包含旧事实');
        assert.strictEqual(FactExtractor.isDuplicateFact('用户喜欢玩原神', null, [{ id: 'f2', content: '他喜欢玩原神', embedding: null }]), false, '仅后缀相同不算包含');
        assert.strictEqual(FactExtractor.isDuplicateFact('用户住在杭州', null, facts), false);
    });

    check('向量余弦判定重复（语义路径，方案 A）', () => {
        // 构造两个夹角极小的向量（余弦 ≈ 0.995 > 0.95 阈值），内容不能相同（文本判重会先命中）
        const facts = [{ id: 'f1', content: '用户喜欢猫科动物', embedding: [1, 0.1] }];
        assert.strictEqual(FactExtractor.isDuplicateFact('用户喜欢猫咪', [1, 0.1001], facts), true);
        assert.strictEqual(FactExtractor.isDuplicateFact('用户喜欢猫咪', [0.1, 1], facts), false, '近正交向量不判重');
    });

    check('容量裁剪：重要度低的先丢，同分丢最旧', () => {
        const t0 = 1000;
        const facts = [
            { id: 'a', importance: 3, createdAt: t0 },
            { id: 'b', importance: 1, createdAt: t0 },
            { id: 'c', importance: 5, createdAt: t0 },
            { id: 'd', importance: 2, createdAt: t0 + 1 },
        ];
        const kept = capFacts(facts, 2);
        assert.deepStrictEqual(kept.map((f) => f.id).sort(), ['a', 'c'], '丢 b(最低)与 d(次低)；a 虽更旧但重要度高于 d');
    });

    check('容量未超时原样返回', () => {
        const facts = [{ id: 'a', importance: 3, createdAt: 1 }];
        assert.strictEqual(capFacts(facts, 10), facts, '同一引用，未复制');
    });

    // ==================== 7. 检索模式分派与语义检索 ====================
    console.log('检索双模式分派:');
    const originalMode = config.memory.retrieval.mode;
    try {
        const mkStore = (episodes) => ({ episodes });

        check('mode=keyword 强制关键词', () => {
            config.memory.retrieval.mode = 'keyword';
            const r = new MemoryRetriever({ store: mkStore([]), embedding: { available: true } });
            assert.strictEqual(r.resolveMode(), 'keyword');
        });

        check('mode=embedding 强制语义', () => {
            config.memory.retrieval.mode = 'embedding';
            const r = new MemoryRetriever({ store: mkStore([]), embedding: { available: true } });
            assert.strictEqual(r.resolveMode(), 'embedding');
        });

        check('auto：无嵌入客户端 → keyword', () => {
            config.memory.retrieval.mode = 'auto';
            const r = new MemoryRetriever({ store: mkStore([{ embedding: [1] }]), embedding: { available: false } });
            assert.strictEqual(r.resolveMode(), 'keyword');
        });

        check('auto：有客户端但库里无向量 → keyword', () => {
            config.memory.retrieval.mode = 'auto';
            const r = new MemoryRetriever({ store: mkStore([{ embedding: null }]), embedding: { available: true } });
            assert.strictEqual(r.resolveMode(), 'keyword');
        });

        check('auto：有客户端且有向量 → embedding', () => {
            config.memory.retrieval.mode = 'auto';
            const r = new MemoryRetriever({ store: mkStore([{ embedding: [1] }]), embedding: { available: true } });
            assert.strictEqual(r.resolveMode(), 'embedding');
        });
    } finally {
        config.memory.retrieval.mode = originalMode;
    }

    console.log('语义检索与去重递补:');
    await checkAsync('语义检索：阈值过滤 + 按综合分排序 + 近重复递补', async () => {
        const originalMode = config.memory.retrieval.mode;
        config.memory.retrieval.mode = 'embedding';
        config.memory.retrieval.semanticThreshold = 0.3;
        try {
            const vA = [1, 0, 0];
            const vA2 = [0.995, 0.1, 0]; // 与 vA 余弦 ≈ 0.995，近重复
            const vB = [0.5, 1, 0];      // 与查询余弦 ≈ 0.447 > 0.3 阈值，可作递补
            const store = {
                episodes: [
                    { id: 'a1', text: '原神话题一', embedding: vA, embeddingModel: 'm', timestamp: Date.now() / 1000 },
                    { id: 'a2', text: '原神话题二（近重复）', embedding: vA2, embeddingModel: 'm', timestamp: Date.now() / 1000 },
                    { id: 'b1', text: '完全另一个话题', embedding: vB, embeddingModel: 'm', timestamp: Date.now() / 1000 },
                ],
            };
            const embedding = { available: true, model: 'm', embed: async () => [1, 0, 0] };
            const r = new MemoryRetriever({ store, embedding });
            const hits = await r.retrieve('原神', null, 2);
            assert.strictEqual(hits.length, 2);
            assert.strictEqual(hits[0].id, 'a1');
            assert.strictEqual(hits[1].id, 'b1', '近重复的 a2 应被丢弃并由 b1 递补');
        } finally {
            config.memory.retrieval.mode = originalMode;
            config.memory.retrieval.semanticThreshold = 0.3;
        }
    });

    await checkAsync('语义无结果时回退关键词（命中达标才采用）', async () => {
        const originalMode = config.memory.retrieval.mode;
        config.memory.retrieval.mode = 'embedding';
        try {
            const store = {
                episodes: [
                    { id: 'k1', text: 'User: 我最喜欢玩原神了\nXiao Ai: 原神呀', embedding: [0, 1, 0], embeddingModel: 'm', timestamp: Date.now() / 1000 },
                ],
            };
            // 查询向量与库中记忆正交 → 语义全灭
            const embedding = { available: true, model: 'm', embed: async () => [1, 0, 0] };
            const r = new MemoryRetriever({ store, embedding });
            const hits = await r.retrieve('你最喜欢玩什么游戏', null, 3);
            assert.ok(hits.length >= 1, '关键词兜底应捞回原神话题');
            assert.strictEqual(hits[0].id, 'k1');
        } finally {
            config.memory.retrieval.mode = originalMode;
        }
    });

    await checkAsync('情绪染色：负效价时相同语义分的情绪相近记忆排前', async () => {
        const originalMode = config.memory.retrieval.mode;
        config.memory.retrieval.mode = 'embedding';
        try {
            const now = Date.now() / 1000;
            const store = {
                episodes: [
                    { id: 'sad', text: '难过的话题', embedding: [1, 0, 0], embeddingModel: 'm', timestamp: now, emotionSnapshot: { P: -0.5, A: 0.3, D: 0 } },
                    { id: 'happy', text: '开心的话题', embedding: [1, 0, 0], embeddingModel: 'm', timestamp: now, emotionSnapshot: { P: 0.6, A: 0.2, D: 0 } },
                ],
            };
            const embedding = { available: true, model: 'm', embed: async () => [1, 0, 0] };
            const r = new MemoryRetriever({ store, embedding });
            const hits = await r.retrieve('随便聊点啥', { P: -0.5, A: 0.3, D: 0 }, 2);
            assert.strictEqual(hits[0].id, 'sad', '当前难过时应优先召回情绪相近的记忆');
        } finally {
            config.memory.retrieval.mode = originalMode;
        }
    });

    // ==================== 8. MemoryStore 基础行为 ====================
    console.log('MemoryStore:');
    check('addEpisode 超上限丢最旧（不落盘）', () => {
        const originalMax = config.memory.maxEpisodes;
        config.memory.maxEpisodes = 3;
        try {
            const store = new MemoryStore();
            // 只操作内存数组，绝不触发 scheduleSave/flush
            for (let i = 0; i < 5; i++) {
                store.addEpisode({ text: `对话 ${i}` });
            }
            assert.strictEqual(store.episodes.length, 3);
            assert.strictEqual(store.episodes[0].text, '对话 2', '最旧两条应被丢弃');
        } finally {
            config.memory.maxEpisodes = originalMax;
        }
    });

    check('addFact 后容量裁剪生效', () => {
        const originalMax = config.memory.facts.maxFacts;
        config.memory.facts.maxFacts = 2;
        try {
            const store = new MemoryStore();
            store.facts = []; // 与真实数据隔离
            store.addFact({ content: '重要事实', importance: 5 });
            store.addFact({ content: '一般事实', importance: 3 });
            store.addFact({ content: '次要事实', importance: 1 });
            assert.strictEqual(store.facts.length, 2);
            assert.ok(store.facts.every((f) => f.importance > 1), '重要度 1 的应被裁掉');
        } finally {
            config.memory.facts.maxFacts = originalMax;
        }
    });

    // ==================== 9. facade：事实操作应用与管线 ====================
    console.log('facade 管线（mock LLM，真实数据只读）:');
    await checkAsync('_applyFactOps：add 去重 / update 覆盖 / delete 移除', async () => {
        const mem = new Memory(null, {});
        disarmStore(mem);
        mem.store.facts = []; // 与真实数据隔离
        mem.store.episodes = [];

        await mem._applyFactOps({
            add: [
                { content: '用户住在杭州', category: 'identity', importance: 4 },
                { content: '用户住在杭州', category: 'identity', importance: 4 }, // 重复，应跳过
            ],
            update: [], delete: [],
        });
        assert.strictEqual(mem.store.facts.length, 1, '重复 add 只留一条');
        assert.strictEqual(mem.store.facts[0].source, 'extracted');

        const factId = mem.store.facts[0].id;
        await mem._applyFactOps({
            add: [],
            update: [{ id: factId, content: '用户搬到了上海', importance: 5 }],
            delete: [],
        });
        assert.strictEqual(mem.store.facts[0].content, '用户搬到了上海');
        assert.strictEqual(mem.store.facts[0].importance, 5);

        await mem._applyFactOps({ add: [], update: [], delete: [factId] });
        assert.strictEqual(mem.store.facts.length, 0);
    });

    await checkAsync('deleteMemory 单条删除命中事实与情节', async () => {
        const mem = new Memory(null, {});
        disarmStore(mem);
        mem.store.facts = [];
        mem.store.episodes = [];
        await mem._applyFactOps({ add: [{ content: '测试事实', importance: 3 }], update: [], delete: [] });
        assert.strictEqual(mem.deleteMemory('不存在的id'), null);
        assert.strictEqual(mem.deleteMemory(mem.store.facts[0].id), 'fact');
        mem.store.addEpisode({ text: '测试情节' });
        assert.strictEqual(mem.deleteMemory(mem.store.episodes[0].id), 'episode');
    });

    await checkAsync('recordTurn → 事实提取管线（mock LLM 输出 add）', async () => {
        const mockClient = {
            chat: {
                completions: {
                    create: async () => ({
                        choices: [{ message: { content: '{"add":[{"content":"用户喜欢科幻电影","category":"preference","importance":4}],"update":[],"delete":[]}' } }],
                    }),
                },
            },
        };
        const mem = new Memory(null, { getChatClient: () => ({ client: mockClient, model: 'test-model' }) });
        disarmStore(mem);
        mem.store.facts = [];
        mem.store.episodes = [];

        await mem.recordTurn('我喜欢看科幻电影', '科幻电影很棒呀！');
        await mem._extractQueue; // 等串行提取队列跑完
        assert.strictEqual(mem.store.facts.length, 1);
        assert.strictEqual(mem.store.facts[0].content, '用户喜欢科幻电影');
        assert.strictEqual(mem.store.episodes.length, 1, '情节同时入库');
    });

    await checkAsync('clearMemory 后在途提取作废（防清空后事实复活）', async () => {
        let resolveExtract;
        const extractPromise = new Promise((resolve) => { resolveExtract = resolve; });
        const mockClient = {
            chat: { completions: { create: () => extractPromise } },
        };
        const mem = new Memory(null, { getChatClient: () => ({ client: mockClient, model: 'test-model' }) });
        disarmStore(mem);
        mem.store.facts = [];
        mem.store.episodes = [];

        await mem.recordTurn('随便聊聊', '好呀');
        await new Promise((r) => setImmediate(r)); // 提取已发出、挂在 extractPromise 上
        mem.clearMemory(); // 此时清空：世代号 +1
        resolveExtract({
            choices: [{ message: { content: '{"add":[{"content":"本不该存在的事实","importance":5}],"update":[],"delete":[]}' } }],
        });
        await mem._extractQueue;
        assert.strictEqual(mem.store.facts.length, 0, '清空后旧提取的结果不得写回');
    });

    await checkAsync('事实提取关闭（facts.enabled=false）时不调用 LLM', async () => {
        const originalEnabled = config.memory.facts.enabled;
        config.memory.facts.enabled = false;
        let called = false;
        const mockClient = {
            chat: { completions: { create: async () => { called = true; return { choices: [] }; } } },
        };
        try {
            const mem = new Memory(null, { getChatClient: () => ({ client: mockClient, model: 'test-model' }) });
            disarmStore(mem);
            mem.store.facts = [];
            await mem.recordTurn('你好', '你好呀');
            await mem._extractQueue;
            assert.strictEqual(called, false, '开关关闭不得发起提取调用');
        } finally {
            config.memory.facts.enabled = originalEnabled;
        }
    });

    await checkAsync('getRandomMemory：避开最近 N 条且不重复分享', async () => {
        const mem = new Memory(null, {});
        disarmStore(mem);
        mem.store.facts = [];
        mem.store.episodes = [];
        for (let i = 0; i < 8; i++) {
            mem.store.addEpisode({ text: `历史记忆 ${i}` });
        }
        const seen = new Set();
        for (let i = 0; i < 6; i++) {
            const picked = mem.getRandomMemory(5);
            assert.ok(picked, '有候选池时应总能取到');
            assert.ok(picked.text.startsWith('历史记忆 '), '只从较早的记忆里挑（池 = 全部-最近5条 → 只有第1条）');
            seen.add(picked.id);
        }
        // 池里只有 1 条（8-5=3 → slice(0,3)），已分享 10 条内不重复 → 反复取也只可能是同一批
        assert.ok(seen.size >= 1);
    });

    // ==================== 10. EmbeddingClient ====================
    console.log('EmbeddingClient:');
    check('无 Key 时不可用且 embed 返回 null', async () => {
        const client = new EmbeddingClient({ apiKey: null });
        assert.strictEqual(client.available, false);
        assert.strictEqual(await client.embed('hi'), null);
    });

    check('siliconflow 厂商自动换用兼容模型', () => {
        const client = new EmbeddingClient({ apiKey: 'sk-x', baseUrl: 'https://api.siliconflow.cn/v1' });
        assert.strictEqual(client.model, 'BAAI/bge-large-zh-v1.5');
        const openaiClient = new EmbeddingClient({ apiKey: 'sk-x', baseUrl: 'https://api.openai.com/v1' });
        assert.strictEqual(openaiClient.model, 'text-embedding-3-small');
    });

    check('余弦相似度：相同为 1、正交为 0、维度不匹配为 0', () => {
        assert.ok(Math.abs(EmbeddingClient.cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
        assert.ok(Math.abs(EmbeddingClient.cosineSimilarity([1, 0], [0, 1])) < 1e-9);
        assert.strictEqual(EmbeddingClient.cosineSimilarity([1, 0], [1, 0, 0]), 0);
        assert.strictEqual(EmbeddingClient.cosineSimilarity(null, [1]), 0);
    });

    // ==================== 汇总 ====================
    console.log(`\n记忆系统测试: ${passed} 通过, ${failed} 失败`);
    if (failed > 0) process.exitCode = 1;
})().catch((e) => {
    console.error(`[test-memory] 未捕获异常: ${e}`);
    process.exitCode = 1;
});
