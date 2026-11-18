import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { block, editor, formula, frac, kbd, launch, mount, settle } from './fixture.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

async function withPage(t, html, opts) {
  const page = await mount(browser, editor(block('target', html)), opts);
  t.after(() => page.close());
  return page;
}

async function applyMark(page, implementation, selector = '#target [contenteditable]') {
  return page.evaluate(({implementation, selector}) => {
    const block = document.querySelector('#target');
    const body = block.closest('.protyle-wysiwyg');
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(selector));
    selection.removeAllRanges();
    selection.addRange(range);
    let calls = 0;
    const toolbar = { setInlineMark() {
      calls++;
      if (implementation === 'noop') return;
      const copy = block.cloneNode(true);
      const copyContent = copy.querySelector('[contenteditable]');
      if (implementation === 'create') copyContent.innerHTML = '<span data-type="kbd">answer</span>';
      if (implementation === 'create-duplicate') copyContent.querySelector('#plain').dataset.type = 'kbd';
      if (implementation === 'merge') copyContent.innerHTML = '<span data-type="kbd">firstmore</span>';
      if (implementation === 'remove') copyContent.querySelector('#answer').replaceWith('answer');
      if (implementation === 'mark-formula') copyContent.querySelector('#math').dataset.type = 'inline-math kbd';
      if (implementation === 'unmark-formula') copyContent.querySelector('#math').dataset.type = 'inline-math';
      if (implementation === 'same-count-wrong-location') {
        const other = copyContent.querySelector('#other');
        other.replaceWith(other.textContent);
      }
      block.replaceWith(copy);
    }};
    window.plugin.handleStandardClozeAction({ toolbar, wysiwyg: { element: body } });
    return { messages: window.messages, calls, count: body.querySelectorAll('[data-type~="kbd"]').length };
  }, { implementation, selector });
}

for (const [name, html, action, selector, count, message] of [
  ['块替换后创建成功', 'answer', 'create', undefined, 1, /已创建/],
  ['公式渲染作为一个位置参与创建校验', formula('math', frac), 'mark-formula', '#math', 1, /已创建/],
  ['公式内容保留，只取消 kbd 标记', formula('math', frac, 'inline-math kbd'), 'unmark-formula', '#math', 0, /已取消/],
  ['相邻标记合并，数量不变仍算创建', kbd('first', 'first') + '<span id="plain">more</span>', 'merge', '#plain', 1, /已创建/],
  ['块被替换但挖空仍在，不算取消成功', kbd('answer', 'answer'), 'replace-only', undefined, 1, /未能确认挖空已取消/],
  ['没有成功时不盲目重复原生切换', kbd('answer', 'answer'), 'noop', undefined, 1, /未能确认挖空已取消/],
  ['取消一个挖空不要求同块其它挖空消失', kbd('answer', 'answer') + ' ' + kbd('other', 'other'), 'remove', '#answer', 1, /已取消/],
  ['不能把同字符数的其它挖空变化当作目标成功', kbd('answer', 'answer') + ' ' + kbd('other', 'other!'), 'same-count-wrong-location', '#answer', 1, /未能确认挖空已取消/],
]) {
  test(name, async t => {
    const page = await withPage(t, html);
    const result = await applyMark(page, action, selector);
    assert.equal(result.calls, 1);
    assert.equal(result.count, count);
    assert.match(result.messages.at(-1), message);
  });
}

test('前面创建同答案的挖空，不会继承后面旧挖空的揭晓记录', async t => {
  const page = await withPage(t, '<span id="plain">answer</span> ' + kbd('answer', 'answer'), { hide: true });
  await page.locator('#answer').click();
  assert.equal(await page.locator('#answer').evaluate(el => el.classList.contains('sy-cloze-unveiled')), true);
  const result = await applyMark(page, 'create-duplicate', '#plain');
  assert.match(result.messages.at(-1), /已创建/);
  await settle(page);
  assert.equal(await page.locator('.sy-cloze-unveiled').count(), 0);
});

for (const mode of ['plain-active', 'rich-active', 'rich-preview', 'rich-multiline', 'rich-remove', 'rich-toolbar']) {
  test('可直接修改表格选区：' + mode, async t => {
    const answer = mode === 'rich-remove' ? kbd('selected', 'answer') : '<span id="selected" data-type="strong">answer</span>';
    const paragraphs = block('inside', 'before ' + answer + ' after') +
      (mode === 'rich-multiline' ? block('inside2', '<span id="second">another</span> rest') : '');
    const cellEditor = '<div class="table__cell-editor"><div class="protyle-wysiwyg">' + paragraphs + '</div></div>';
    const page = await mount(browser, editor(block('outside', 'old toolbar selection') + '<div data-node-id="table" data-type="NodeTable"><table><tbody><tr><td' +
      (mode === 'plain-active' ? '' : ' data-sy-table-cell-rich="saved"') + '>' +
      (mode === 'rich-preview' ? '<div class="table__cell-rich">' + paragraphs + '</div>' : cellEditor) +
      '</td><td id="neighbor">untouched</td></tr></tbody></table></div>'));
    t.after(() => page.close());
    const result = await page.evaluate(({ mode, cellEditor }) => {
      const body = document.querySelector('.protyle-wysiwyg');
      const cell = body.querySelector('td');
      const setSelection = () => {
        const range = document.createRange();
        const start = cell.querySelector('#selected').firstChild;
        range.setStart(start, 0);
        range.setEnd(mode === 'rich-multiline' ? cell.querySelector('#second').firstChild : start, mode === 'rich-multiline' ? 7 : 6);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      };
      let priorPath = false;
      document.addEventListener('pointerdown', () => {
        priorPath = true;
        cell.innerHTML = 'before answer after';
      }, { capture: true, once: true });
      body.addEventListener('keyup', () => {
        queueMicrotask(() => { cell.innerHTML = cellEditor; setSelection(); });
      });
      const calls = [];
      const toolbar = {
        setInlineMark() { calls.push('outer-transaction'); },
        setInlineMarkInBlock(_editor, type, action, textObj, remove, focusRange) {
          calls.push([type, action, textObj, remove, focusRange]);
          const range = this.range;
          const fragment = range.extractContents();
          if (remove) {
            fragment.querySelectorAll('[data-type="kbd"]').forEach(span => span.replaceWith(...span.childNodes));
            range.insertNode(fragment);
          } else {
            const span = document.createElement('span');
            span.dataset.type = 'kbd';
            span.append(fragment);
            range.insertNode(span);
          }
        },
      };
      setSelection();
      if (mode === 'rich-toolbar') {
        toolbar.range = document.createRange();
        toolbar.range.selectNodeContents(document.querySelector('#outside [contenteditable]'));
      }
      window.plugin.handleStandardClozeAction({ toolbar, wysiwyg: { element: body } }, undefined, mode === 'rich-toolbar');
      return new Promise(resolve => {
        const done = () => resolve({
          calls, priorPath, messages: window.messages,
          answers: [...cell.querySelectorAll('[data-type~="kbd"]')].map(el => el.textContent),
          strong: [...cell.querySelectorAll('[data-type~="strong"]')].map(el => el.textContent).join(''),
          neighbor: document.querySelector('#neighbor').textContent,
        });
        requestAnimationFrame(() => requestAnimationFrame(done));
      });
    }, { mode, cellEditor });
    const removing = mode === 'rich-remove';
    assert.equal(result.priorPath, false);
    assert.deepEqual(result.calls, Array.from({ length: mode === 'rich-multiline' ? 2 : 1 }, () => ['kbd', 'range', undefined, removing, false]));
    assert.deepEqual(result.answers, removing ? [] : mode === 'rich-multiline' ? ['answer after', 'another'] : ['answer']);
    if (!removing) assert.equal(result.strong, 'answer');
    assert.equal(result.neighbor, 'untouched');
    assert.match(result.messages.at(-1), removing ? /已取消/ : /已创建/);
  });
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => ({ text: getSelection().toString(), up: window.mouseup }));
}

for (const fromAnswer of [true, false]) {
  test(fromAnswer ? '可从已遮蔽答案内部开始拖选' : '拖入遮蔽答案时编辑器仍收到 mouseup', async t => {
    const page = await withPage(t, '<span id="lead">ordinary words </span>' + kbd('answer', 'selected answer text'), { hide: true });
    await page.evaluate(() => {
      window.mouseup = 0;
      document.querySelector('[contenteditable]').addEventListener('mouseup', () => window.mouseup++);
    });
    const answer = await page.locator('#answer').boundingBox();
    const start = fromAnswer ? answer : await page.locator('#lead').boundingBox();
    const y = answer.y + answer.height / 2;
    const picked = await drag(page, { x: start.x + 4, y }, { x: answer.x + answer.width - 4, y });
    assert.match(picked.text, /selected answer/);
    assert.equal(picked.up, 1);
    await settle(page);
    assert.equal(await page.locator('#answer').evaluate(el => el.classList.contains('sy-cloze-unveiled')), false);
  });
}

test('按住遮挡内容不动，按下和松手都不进入文字选择', async t => {
  const page = await withPage(t, kbd('answer', 'answer text'), { hide: true });
  await page.evaluate(() => {
    window.editorEvents = [];
    const editor = document.querySelector('[contenteditable]');
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      editor.addEventListener(type, () => window.editorEvents.push(type));
    }
  });
  const answer = page.locator('#answer');
  const box = await answer.boundingBox();
  const snapshot = () => answer.evaluate(el => ({
    ranges: getSelection().rangeCount,
    selected: getSelection().toString(),
    shown: el.classList.contains('sy-cloze-unveiled'),
    events: window.editorEvents.slice(),
  }));
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  assert.deepEqual(await snapshot(), { ranges: 0, selected: '', shown: false, events: [] });
  await page.mouse.move(x + 2, y);
  const started = await page.evaluate(() => performance.now());
  await page.waitForFunction(at => performance.now() - at >= 500, started);
  assert.deepEqual(await snapshot(), { ranges: 0, selected: '', shown: false, events: [] });
  await page.mouse.up();
  assert.deepEqual(await snapshot(), { ranges: 0, selected: '', shown: true, events: [] });
});

test('关闭遮挡后，点击答案仍能放置编辑光标', async t => {
  const page = await withPage(t, kbd('answer', 'answer text'), { hide: false });
  const answer = page.locator('#answer');
  await answer.click();
  assert.equal(await answer.evaluate(el => getSelection().rangeCount === 1 && el.contains(getSelection().anchorNode)), true);
});

test('鼠标连点切换后没有文字选区，也不会把答案留在显示状态', async t => {
  const page = await withPage(t, kbd('answer', 'answer text'), { hide: true });
  await page.locator('#answer').dblclick();
  await settle(page);
  const state = await page.locator('#answer').evaluate(el => ({
    selected: getSelection().toString(),
    revealed: el.classList.contains('sy-cloze-unveiled') || el.classList.contains('sy-cloze-reveal'),
  }));
  assert.deepEqual(state, { selected: '', revealed: false });
});

for (const mode of ['mouse', 'touch']) {
  test(mode + ' 轻点仍切换揭晓，不传给编辑器普通 click 监听', async t => {
    const page = await withPage(t, kbd('answer', 'answer text'), { hide: true, context: { hasTouch: mode === 'touch' } });
    await page.evaluate(() => {
      window.editorEvents = [];
      const editor = document.querySelector('[contenteditable]');
      for (const type of ['click', 'mouseup', 'mousedown']) editor.addEventListener(type, () => window.editorEvents.push(type));
    });
    const answer = page.locator('#answer');
    const point = await answer.boundingBox();
    const coords = [point.x + point.width / 2, point.y + point.height / 2];
    const click = () => mode === 'touch' ? page.touchscreen.tap(...coords) : page.mouse.click(...coords);
    const opened = () => answer.evaluate(el => el.classList.contains('sy-cloze-unveiled'));
    await click();
    assert.equal(await opened(), true);
    assert.equal(await page.evaluate(() => getSelection().rangeCount), 0, '轻点不能在答案里留下光标');
    await click();
    assert.equal(await opened(), false);
    assert.equal(await page.evaluate(() => getSelection().rangeCount), 0);
    assert.deepEqual(await page.evaluate(() => window.editorEvents), []);
  });
}
