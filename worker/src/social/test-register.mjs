/** 通过 node --import 注册 test-hooks.mjs（见 social.test.ts 顶部的运行命令）。 */
import { register } from 'node:module';

register('./test-hooks.mjs', import.meta.url);
