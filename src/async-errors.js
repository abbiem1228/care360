// Express 4 only catches errors thrown synchronously by a route. A route
// that is an async function returns a promise instead, and if that
// promise rejects nobody handles it, so Node stops the whole server.
// This sends those rejections to next(err) as well, so they reach the
// error handler in server.js like any other error. Required once, before
// any request is served.
const Layer = require('express/lib/router/layer');

Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next(); // an error handler, not a request handler
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') {
      result.catch(err => next(err || new Error('Route promise rejected without a reason')));
    }
  } catch (err) {
    next(err);
  }
};

// Last line of defence for a promise outside any request (a timer job,
// say): log it and keep serving rather than exit.
process.on('unhandledRejection', reason => {
  console.error('Unhandled promise rejection (server kept running):', reason);
});

// The route pattern, not the address, so a token in the address never
// reaches the logs.
const routeLabel = req => `${req.method} ${req.route ? req.baseUrl + req.route.path : req.baseUrl || '(no route)'}`;

module.exports = { routeLabel };
