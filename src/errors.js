// all errors are returned as { error: { code, message, details } }
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const validation = (message, details) => new ApiError(400, 'VALIDATION_ERROR', message, details);
const accountNotFound = (id) => new ApiError(404, 'ACCOUNT_NOT_FOUND', `Account '${id}' not found`);
const insufficientBalance = (balance, amount) =>
  new ApiError(422, 'INSUFFICIENT_BALANCE', 'Insufficient balance for this debit', { balance, amount });

module.exports = { ApiError, validation, accountNotFound, insufficientBalance };
