const imageProxyBase = "/api";

/** 为 HTTP 页面和 HTTPS 部署环境生成可显示的巡检图片地址。 */
export function displayPhotoUrl(source?: string | null) {
  const url = String(source || '').trim();
  if (!url || /^(data:|blob:)/i.test(url)) return url;

  const isQiniuTestDomain = /^https?:\/\/[^/]+\.clouddn\.com\//i.test(url);
  const pageIsHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';

  if (!pageIsHttps && isQiniuTestDomain) {
    return url.replace(/^https:/i, 'http:');
  }
  if (pageIsHttps && (/^http:/i.test(url) || isQiniuTestDomain)) {
    return `${imageProxyBase}/upload/image?url=${encodeURIComponent(url)}`;
  }
  return url;
}
