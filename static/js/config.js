'use strict';
/**
 * 公共配置：探测后端 API 地址
 * - HTTP 服务访问（http://localhost:3000/...）：直接用相对路径 /api/...
 * - file:// 直接打开页面：CSS/JS 用相对路径加载，API 请求跨域到后端。
 *   后端地址 = localStorage('oc_api_base') || http://localhost:3000
 */
(function () {
  const isFile = location.protocol === 'file:';
  let apiBase = '';
  if (!isFile) {
    // HTTP 下同源，直接用相对路径
    apiBase = '';
  } else {
    // file:// 下读取自定义后端地址（可在控制台设置 localStorage.setItem('oc_api_base', 'http://127.0.0.1:3000')）
    apiBase = localStorage.getItem('oc_api_base') || 'http://localhost:3000';
  }

  window.API_BASE = apiBase;
  // 统一 API 请求入口：把相对路径拼上后端地址
  window.apiUrl = function (path) {
    if (!path) return apiBase || '';
    return apiBase + path;
  };
})();
