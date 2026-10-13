/**
 * 测试共用件：在 Node 里装一份真实 DOM，并把夹具包进带 data-node-id 的块。
 * 文件名不以 .test.mjs 结尾，因此不会被 node --test 当成用例执行。
 */
import { JSDOM } from 'jsdom';

export const ZW = '\u200b';
export const WJ = '\u2060';

/** 装全局 Node / document，供 src/cluster.ts 直接调用。 */
export const setupDom = () => {
  const jsdom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.Node = jsdom.window.Node;
  globalThis.document = jsdom.window.document;
  return jsdom.window;
};

/** getClozeCluster 要求起始 kbd 落在某个 [data-node-id] 块内。 */
export const parseBlock = (html) => {
  const block = document.createElement('div');
  block.setAttribute('data-node-id', 'fixture');
  block.innerHTML = html;
  return block;
};
