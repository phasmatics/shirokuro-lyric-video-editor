// Google Analytics is for the published site; local editing is not measured.
(() => {
  const host = window.location.hostname;
  if (!['http:', 'https:'].includes(window.location.protocol) ||
      host === 'localhost' || host.endsWith('.localhost') ||
      /^127\./.test(host) || host === '[::1]') return;

  const measurementId = 'G-Q9S5E2T144';
  if (document.getElementById('google-analytics-tag')) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', measurementId, {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  const script = document.createElement('script');
  script.id = 'google-analytics-tag';
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId;
  document.head.append(script);
})();
