// src/routes/chat.js
// Shim file: keep server.js imports stable.
// All chat logic lives under ./chat/ (modular route package).
export { chatRoutes } from "./chat/index.js";
import { chatRoutes as _chatRoutes } from "./chat/index.js";
export default _chatRoutes;
