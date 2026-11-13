// HTTP status codes used outside route return helpers (Boom covers errors).
export const HTTP_STATUS = Object.freeze({
  ok: 200,
  created: 201,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  tooManyRequests: 429,
  serverError: 500,
  serviceUnavailable: 503
})
