// 测试加载器入口：node --import ./src/bot/test/register.mjs --test ...
// 让 Node 原生运行 .ts 时，可以省略相对导入的 .ts 扩展名（与 tsc / Workers 打包的写法一致）。
import { register } from 'node:module';

register('./resolve-hook.mjs', import.meta.url);
