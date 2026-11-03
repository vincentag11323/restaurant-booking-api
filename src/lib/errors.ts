/** Thrown anywhere in a request; turned into `{ message }` JSON by the error middleware. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message = "Reservation not found") => new HttpError(404, message);
