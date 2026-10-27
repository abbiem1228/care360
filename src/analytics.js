// Google Tag Manager and the conversion events it receives. The container
// id is public. GTM loads only on public, signed-out pages (/plans, /coach,
// sign-up, sign-in), the sign-up and checkout hand-off pages, and the page
// people return to after Stripe checkout. Never on a dashboard, report,
// survey, invite or password reset page. Events carry no names, emails or
// tokens. GTM_ID= (empty) in the environment turns the container off, for
// local tests; dataLayer pushes still happen so they can be checked.
const GTM_ID = process.env.GTM_ID === undefined ? 'GTM-PQWRNQPQ' : process.env.GTM_ID;

const gtmHead = () => GTM_ID ? `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM_ID}');</script>` : '';
const gtmBody = () => GTM_ID ? `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${GTM_ID}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>` : '';

// JSON that is safe inside a <script> tag.
const scriptJson = v => JSON.stringify(v).replace(/</g, '\\u003c');

// A dataLayer push, placed in <head> before the GTM snippet so it is
// queued before the container starts.
const pushEvent = data => data ? `<script>(window.dataLayer=window.dataLayer||[]).push(${scriptJson(data)});</script>` : '';

const audienceOf = coach => coach ? 'coach' : 'organization';

// A page that exists only to hand one event to GTM and move on, for the
// two moments that otherwise end in a redirect: a sign-up that goes
// straight on, and the step into Stripe Checkout. It moves on as soon as
// GTM has the event, or after a second if GTM is blocked or slow.
function handoffPage(data, next) {
  const url = scriptJson(next);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<noscript><meta http-equiv="refresh" content="0;url=${next.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/></noscript>
<title>One moment | care 360</title><link rel="icon" type="image/svg+xml" href="/img/care-mark.svg"/>
<script>(function(){var gone=false;function go(){if(gone)return;gone=true;location.replace(${url})}
var d=${scriptJson(data)};d.eventCallback=go;d.eventTimeout=1000;(window.dataLayer=window.dataLayer||[]).push(d);setTimeout(go,1000)})();</script>
${gtmHead()}
<style>body{font-family:'Noto Sans',Arial,sans-serif;background:#fff;color:#637074;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-size:15px}</style>
</head><body>${gtmBody()}<p>One moment…</p></body></html>`;
}

module.exports = { gtmHead, gtmBody, pushEvent, handoffPage, audienceOf };
