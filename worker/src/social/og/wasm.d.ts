/** 以模块方式导入的 .wasm 文件类型（Workers 运行时直接给出 WebAssembly.Module）。 */
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
