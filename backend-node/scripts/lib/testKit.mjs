/**
 * testKit.mjs - 测试断言的统一外壳（B5-1 / B5-2 / 审计 INFRA-01、INFRA-02）。
 *
 * 这一层只为解决一件事：**让「用例没跑」也等于失败**。
 * 审计时发现三条 suite 的 `check()` 只累加失败数、从不核对总断言条数，
 * 于是把整节注释掉、或者中途 return 提前退出，套件照样打印 OK 并 exit 0
 * —— CI 永远是绿的，测试只是装饰。stream-filter 那条则硬编码了一个 `TOTAL`，
 * 加用例时必须记得改它。
 *
 * 用法：
 *   const t = createHarness('套件名', { expect: 42 });
 *   t.check('这条应该通过', cond, '可选细节');
 *   t.finish();   // 断言数对不上或有失败 → 打印差异并 exit(1)
 *
 * 为什么不做完整的 node:test 迁移（B5-3 的原提案）：现有 10 个脚本各自带着
 * 「备份/还原真实 data 文件、动态 import 顺序、沙盒目录」的装配逻辑，
 * 整体搬迁的风险远大于收益；把「能失败」这件事收进一处即可达到同样效果。
 */

/**
 * @param {string} name 套件名（打印用）
 * @param {{expect?: number}} [opts] expect = 本套件**应当执行的断言条数**（新增/删除用例时要同步改）
 */
export function createHarness(name, { expect = null } = {}) {
    let passed = 0;
    let failed = 0;
    const failures = [];

    const check = (title, cond, detail = '') => {
        if (cond) {
            passed++;
            console.log(`  OK  ${title}`);
            return;
        }
        failed++;
        const line = `${title}${detail ? ` — ${detail}` : ''}`;
        failures.push(line);
        console.error(`  FAIL ${line}`);
    };

    /** 异步用例：抛异常即算失败，且不中断后续用例 */
    const checkAsync = async (title, fn, detail = '') => {
        try {
            await fn();
            check(title, true);
        } catch (e) {
            check(title, false, `${detail ? `${detail} ` : ''}${e?.message || e}`);
        }
    };

    /**
     * 核对并打印结论。
     *
     * ⚠️ 默认**不**直接 process.exit：这些套件都在 try/finally 里备份并还原真实
     * data/*.json，失败时立刻退出会跳过 finally → 用户数据留在被测试污染的状态。
     * 调用方应在 finally 之后再 `process.exit(code)`；只有无需清理的套件才传 { exit: true }。
     * @returns {number} 退出码（0 = 全绿且断言条数符合预期）
     */
    const finish = ({ exit = false } = {}) => {
        const ran = passed + failed;
        console.log(`\n[${name}] ${passed}/${expect ?? ran} 通过，${failed} 失败`);
        let code = 0;
        if (failures.length) {
            console.error('失败明细：');
            for (const f of failures) console.error(`  - ${f}`);
            code = 1;
        } else if (expect === null) {
            console.error(
                `[${name}] 没有声明 expect：套件必须写明应有断言条数，`
                + '否则「用例没跑」不会被发现（INFRA-01）。'
            );
            code = 1;
        } else if (ran !== expect) {
            console.error(
                `[${name}] 断言条数不符：执行了 ${ran} 条，声明应有 ${expect} 条。\n`
                + '        多半是有用例被跳过、被注释掉，或某节中途 return 了 —— 这正是审计 INFRA-02 的失效方式。'
            );
            code = 1;
        }
        if (exit) process.exit(code);
        return code;
    };

    return { check, checkAsync, finish, counts: () => ({ passed, failed }) };
}
