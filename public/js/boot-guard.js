/**
 * NVW · 启动守卫
 * 目的：页面停在"静态外壳"（HTML/CSS 都在，但脚本一行没跑）时，**把原因直接写进页面**，
 * 不必打开 DevTools。典型场景：模块请求撞上服务重启窗口、扩展拦截、浏览器缓存了旧模块、
 * 或某个模块解析失败 —— 这些在纯静态壳里是完全看不出来的。
 *
 * 必须在其它脚本之前加载（index.html head 第一行）。
 */
(function () {
  var reported = false;

  function box() {
    return document.getElementById('bootError');
  }

  function report(kind, detail) {
    reported = true;
    try {
      var el = box();
      if (!el) return;
      el.hidden = false;
      el.textContent = '[NVW] ' + kind + ': ' + detail;
      try { console.error('[NVW boot]', kind, detail); } catch (e) {}
    } catch (e) { /* 连报错都失败就只能算了 */ }
  }

  // 1) 资源加载失败（<script>/<link> 的 error 不会冒泡，必须捕获阶段监听）
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK' || t.tagName === 'IMG')) {
      report('资源加载失败', (t.src || t.href || t.tagName) + ' —— 服务是否在运行？');
      return;
    }
    if (e && e.message) {
      report('脚本错误', e.message + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?'));
    }
  }, true);

  // 2) 未处理的 Promise 拒绝（模块顶层 await 失败会走这里）
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    report('未处理的 Promise 拒绝', (r && (r.stack || r.message)) || String(r));
  });

  // 3) 兜底：4 秒后 app 还没宣告启动成功，说明模块图没跑起来
  setTimeout(function () {
    if (window.__NVW_BOOTED__ || reported) return;
    report('应用未启动', '4 秒内未收到启动信号：app.js 或其依赖模块没能执行');
  }, 4000);

  window.__NVW_REPORT__ = report;
})();
