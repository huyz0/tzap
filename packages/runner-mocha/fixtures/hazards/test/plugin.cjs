// A root-hook plugin and global fixtures, loaded by `require` in .mocharc.json.
exports.mochaHooks = {
  beforeEach() {
    globalThis.rootHook = 'set';
  },
  afterEach() {
    globalThis.rootHook = 'cleared';
  },
};
exports.mochaGlobalSetup = function () {
  globalThis.globalSetups = (globalThis.globalSetups ?? 0) + 1;
};
