import app from "../app.js";

export default app;

export const config = {
  api: {
    bodyParser: false,
    responseLimit: "8mb"
  }
};
