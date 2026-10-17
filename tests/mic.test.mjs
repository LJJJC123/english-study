/* Run: node tests/mic.test.mjs [index.html] — exercise the real mic flow with browser audio boundaries simulated. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(process.argv[2] || new URL('../index.html', import.meta.url), 'utf8');
const start = html.includes('var ieltsMicState =') ? html.indexOf('var ieltsMicState =') : html.indexOf('async function ieltsMic(');
const source = html.slice(start, html.indexOf('\nfunction renderIeltsChat(', start));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup({ permissionError, noRecognition = false, deferredPermission = false } = {}) {
  const els = Object.fromEntries(['btnMic', 'chatInput', 'btnSendMsg', 'btnEndIelts', 'micHint', 'micPlayback'].map(id => [id, {
    disabled: false, innerHTML: '', value: '', hidden: true, textContent: '',
    setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; }
  }]));
  const timers = new Map(), blobs = new Map(), notices = [], recognizers = [], recorders = [];
  let now = 1000, stopped = false, grant;
  const stream = { getTracks: () => [{ stop() { stopped = true; } }] };
  class Recorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/ogg'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['recorded audio'], { type: this.mimeType }) }); this.onstop?.(); });
    }
  }
  class Recognition {
    constructor() { recognizers.push(this); }
    start() { this.onstart?.(); }
    stop() { queueMicrotask(() => this.onend?.()); }
    result(text, isFinal = true) {
      const result = [{ transcript: text, confidence: 0.9 }]; result.isFinal = isFinal;
      this.onresult?.({ resultIndex: 0, results: [result] });
    }
  }
  const context = vm.createContext({
    Blob, MediaRecorder: Recorder, Date: { now: () => now },
    navigator: { mediaDevices: { getUserMedia: async () => {
      if (permissionError) throw { name: permissionError };
      if (deferredPermission) await new Promise(resolve => { grant = resolve; });
      return stream;
    } } },
    window: { MediaRecorder: Recorder, SpeechRecognition: noRecognition ? undefined : Recognition, speechSynthesis: { cancel() {} } },
    $: id => els[id.slice(1)], icon: () => '🎤', toast: text => notices.push(text),
    ieltsSess: {}, URL: { createObjectURL(blob) { const url = 'blob:' + blobs.size; blobs.set(url, blob); return url; }, revokeObjectURL() {} },
    setTimeout: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(source, context);
  return { context, els, notices, blobs, recognizers, recorders, timers, get stopped() { return stopped; },
    advance(ms) { now += ms; }, grant() { grant(); },
    async click() { const pending = context.ieltsMic(); await flush(); return { pending }; },
    async restart() { const ready = [...timers].filter(([, timer]) => timer.ms < 1000); for (const [id, timer] of ready) { timers.delete(id); timer.fn(); } await flush(); }
  };
}

const env = setup();
const first = await env.click();
assert.equal(env.els.btnMic.disabled, false, '录音开始后按钮必须可再次点击停止');
assert.match(env.els.btnMic.innerHTML, /停止/);
const r = env.recognizers[0];
assert.equal(r.continuous, true, '必须支持多句话');
r.result('First sentence.'); await flush();
assert.equal(env.stopped, false, '首句话不能结束整段录音');
r.onend(); await env.restart();
r.result('Second sentence.'); await flush();
assert.match(env.els.chatInput.value, /First sentence.*Second sentence/, '识别重启后仍保留前一句');
r.onerror({ error: 'network' }); r.onend(); await env.restart();
assert.equal(env.stopped, false, '识别服务故障不能掐断录音');
assert.match(env.notices.join(' '), /识别.*录音/);
env.advance(20000);
await env.click(); await first.pending;
assert.equal(env.stopped, true, '再次点击释放麦克风');
assert.equal(env.context.window.__lastMicSecs, 20, '超过原先 12 秒限制仍计入完整时长');
assert.equal(env.blobs.get(env.context.window.__lastMicUrl).type, 'audio/ogg', '回放格式沿用实际录音格式');
assert.equal(env.els.micPlayback.hidden, false, '停止后可以先回放再填写文字');
assert.equal(env.els.btnMic.disabled, false);
console.log('✓ 连续多句、识别中断/网络失败、手动停止、完整时长与回放');

const fallback = setup({ noRecognition: true });
const fallbackFirst = await fallback.click();
assert.equal(fallback.recorders[0]?.state, 'recording', '无语音识别也能录音');
await fallback.click(); await fallbackFirst.pending;
assert.ok(fallback.context.window.__lastMicUrl);
console.log('✓ 无语音识别时仍可录音回放');

const denied = setup({ permissionError: 'NotAllowedError' });
await (await denied.click()).pending;
assert.equal(denied.els.btnMic.disabled, false);
assert.match(denied.notices.join(' '), /权限/);
console.log('✓ 权限拒绝时明确提示并恢复按钮');

const slow = setup({ deferredPermission: true });
const slowFirst = await slow.click();
await slow.click();
slow.grant(); await flush();
assert.equal(slow.recorders.length, 1, '权限等待期间连点不能重复打开录音');
await slow.click(); await slowFirst.pending;
assert.equal(slow.stopped, true);
console.log('✓ 等待授权期间连点不会重复占用麦克风');

const unresponsive = setup();
const unresponsiveFirst = await unresponsive.click();
const stalled = unresponsive.recognizers[0];
stalled.result('Keep this answer.');
stalled.stop = () => {}; // Recognition server never acknowledges stop.
const stopping = unresponsive.click();
await flush();
for(const [id, timer] of unresponsive.timers){
  if(timer.ms === 1500){ unresponsive.timers.delete(id); timer.fn(); }
}
await stopping; await unresponsiveFirst.pending;
assert.equal(unresponsive.stopped, true, '识别服务无响应也能停止并释放麦克风');
stalled.result('A late response from the previous recording.');
assert.equal(unresponsive.els.chatInput.value, 'Keep this answer.', '旧识别回调不能覆盖停止后的回答');
console.log('✓ 停止超时仍释放麦克风，迟到识别结果不覆盖回答');
