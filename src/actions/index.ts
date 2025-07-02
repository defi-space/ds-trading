import { goalActions } from "./goals";
import { toolActions } from "./tools";

// Export actions as an array instead of an object
export const actions = [...goalActions, ...toolActions];
