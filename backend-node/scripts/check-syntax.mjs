/**
 * 语法检查：用 vm.SourceTextModule 解析 src/ 下所有 .js 文件（仅解析不执行）。
 * 用法：npm run check
 * （需要 --experimental-vm-modules，已在 package.json 中配置）
 */
import vm from 'node:vm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '..', 'src');

function collectJsFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...collectJsFiles(full));
        else if (entry.name.endsWith('.js')) files.push(full);
    }
    return files;
}

let failed = 0;
const files = collectJsFiles(srcDir);
for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8');
    try {
        // SourceTextModule 构造时会做完整 ESM 语法解析（不执行任何代码）
        new vm.SourceTextModule(source, { identifier: file });
        console.log(`OK    ${path.relative(srcDir, file)}`);
    } catch (e) {
        failed++;
        console.error(`FAIL  ${path.relative(srcDir, file)}\n  ${e.message}`);
    }
}

console.log(`\n${files.length - failed}/${files.length} files passed syntax check`);
process.exit(failed > 0 ? 1 : 0);
