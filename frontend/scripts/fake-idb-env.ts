/** esbuild --inject 入口：在被测 db 模块实例化 Dexie 前注入 IndexedDB 全局 */
import 'fake-indexeddb/auto';
export {};
