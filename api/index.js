import app from "../app.js";

export default app;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4mb"
    },
    responseLimit: "8mb"
  }
};
