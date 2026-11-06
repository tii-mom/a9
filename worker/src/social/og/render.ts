/**
 * 分享图 SVG → PNG（1200x630），基于 @resvg/resvg-wasm。
 * wasm 以模块方式导入（Workers 原生支持 .wasm 模块），每个 isolate 只初始化一次。
 * 字体只内嵌 Barlow Bold（Latin），因此卡片文案只能用数字与英文，不能含 CJK 字形。
 */
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { BARLOW_BOLD_BASE64 } from '../fonts/barlow-bold';

const CARD_WIDTH = 1200;
const FONT_FAMILY = 'Barlow';

let ready: Promise<void> | null = null;
let fontBytes: Uint8Array | null = null;

function ensureReady(): Promise<void> {
  if (!ready) {
    // 初始化失败时清空缓存，下一次请求可以重试，而不是永久失败。
    ready = initWasm(resvgWasm).catch((err: unknown) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

function loadFont(): Uint8Array {
  if (!fontBytes) {
    const binary = atob(BARLOW_BOLD_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    fontBytes = bytes;
  }
  return fontBytes;
}

/** 将 SVG 渲染为 1200 宽的 PNG。失败时抛错，由调用方决定回退。 */
export async function renderPng(svg: string): Promise<Uint8Array> {
  await ensureReady();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: CARD_WIDTH },
    font: { fontBuffers: [loadFont()], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
  });
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}
