import { z, type ZodSchema } from "zod";
import { saveContextWorkingMemory } from "./context";
import {
  getPathSegments,
  getValueByPath,
  handleActionCall,
  handleInput,
  handleOutput,
  NotFoundError,
  ParsingError,
  prepareActionCall,
  prepareContext,
  resolvePathSegments,
  resolveTemplates,
} from "./handlers";
import type { Logger } from "./logger";
import { generateEpisode } from "./memory/utils";
import type { StepConfig } from "./prompts/main";
import type { TaskRunner } from "./task";
import type {
  ActionCall,
  ActionCtxRef,
  ActionResult,
  AnyAction,
  AnyAgent,
  AnyRef,
  ContextRef,
  ContextState,
  EventRef,
  Handlers,
  Input,
  Log,
  Output,
  OutputRef,
  RunRef,
  StepRef,
  WorkingMemory,
} from "./types";
import { randomUUIDv7 } from "./utils";
import { xmlStreamParser } from "./xml";
import pDefer from "p-defer";

type PartialLog = Partial<Log> &
  Pick<Log, "ref" | "id" | "timestamp" | "processed">;

type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>;

export type StackElement = {
  index: number;
  tag: string;
  attributes: Record<string, any>;
  content: string;
  done: boolean;
  _depth: number;
};

export async function handleStream<Ctx = any>(
  textStream: AsyncGenerator<string>,
  initialIndex: number,
  tags: Set<string>,
  fn: (el: StackElement, ctx?: Ctx) => void,
  ctx?: Ctx
) {
  let current: StackElement | undefined = undefined;
  let stack: StackElement[] = [];

  let index = initialIndex;

  const parser = xmlStreamParser(tags, (tag, isClosingTag) => {
    if (current?.tag === tag && !isClosingTag && tag === "think") {
      return false;
    }

    if (current?.tag === tag && !isClosingTag && tag === "response") {
      return false;
    }

    if (current?.tag === tag && !isClosingTag && tag === "reasoning") {
      return false;
    }

    if (current?.tag === tag && !isClosingTag && tag === "output") {
      current._depth++;
      return false;
    }

    if (current?.tag === tag && !isClosingTag) {
      current._depth++;
      return false;
    }

    if (current?.tag === tag && isClosingTag) {
      if (current._depth > 0) {
        current._depth--;
        return false;
      }

      return true;
    }

    if (current === undefined || current?.tag === "response") return true;

    if (isClosingTag && stack.length > 0) {
      const stackIndex = stack.findIndex((el) => el.tag === tag);
      if (stackIndex === -1) return false;

      if (current) {
        fn(
          {
            ...current,
            done: true,
          },
          ctx
        );

        current = undefined;
      }

      const closed = stack.splice(stackIndex + 1).reverse();

      for (const el of closed) {
        fn(
          {
            ...el,
            done: true,
          },
          ctx
        );
      }

      current = stack.pop();

      return true;
    }

    return false;
  });

  parser.next();

  function handleChunk(chunk: string) {
    let result = parser.next(chunk);
    while (!result.done && result.value) {
      if (result.value.type === "start") {
        if (current) stack.push(current);
        current = {
          index: index++,
          tag: result.value.name,
          attributes: result.value.attributes,
          content: "",
          done: false,
          _depth: 0,
        };
        fn(current, ctx);
      }

      if (result.value.type === "end") {
        if (current)
          fn(
            {
              ...current,
              done: true,
            },
            ctx
          );
        current = stack.pop();
      }

      if (result.value.type === "text") {
        if (current) {
          // If we're in an output tag and the content has XML-like tags,
          // we can handle it specially to avoid parsing issues
          if (current.tag === "output" && 
              (result.value.content.includes('<') && result.value.content.includes('>'))) {
            // Just add the content without trying to parse it as XML
            current.content += result.value.content;
          } else {
            current.content += result.value.content;
          }
          fn(current, ctx);
        }

        // todo: we need to handle text when !current to a default output?
      }
      result = parser.next();
    }
  }

  for await (const chunk of textStream) {
    handleChunk(chunk);
  }

  parser.return?.();
}

export async function* wrapStream(
  stream: AsyncIterable<string>,
  prefix: string,
  suffix: string
) {
  yield prefix;
  for await (const value of stream) {
    yield value;
  }
  yield suffix;
}

const defaultTags = new Set([
  "think",
  "thinking",
  "response",
  "output",
  "action_call",
  "reasoning",
]);

export function createContextStreamHandler({
  agent,
  ctxState,
  agentCtxState,
  logger,
  handlers,
  taskRunner,
  workingMemory,
  stepConfig,
  abortSignal,
  subscriptions,
}: {
  agent: AnyAgent;
  taskRunner: TaskRunner;
  ctxState: ContextState;
  agentCtxState?: ContextState;
  logger: Logger;
  handlers?: Partial<Handlers>;
  workingMemory: WorkingMemory;
  stepConfig: StepConfig;
  abortSignal?: AbortSignal;
  subscriptions: Set<(log: AnyRef, done: boolean) => void>;
}) {
  const runRef: RunRef = {
    id: randomUUIDv7(),
    ref: "run",
    type: ctxState.context.type,
    data: {},
    processed: false,
    timestamp: Date.now(),
  };

  async function createStep() {
    const newStep: StepRef = {
      ref: "step",
      id: randomUUIDv7(),
      step: state.step,
      type: stepConfig.name,
      data: {},
      processed: false,
      timestamp: Date.now(),
    };

    state.steps.push(newStep);
    workingMemory.steps.push(newStep);

    await handlePushLog(newStep, true);

    return newStep;
  }

  async function prepare() {
    const { actions, contexts, outputs, inputs } = await prepareContext({
      agent,
      ctxState,
      workingMemory,
      agentCtxState,
      params: state.params,
    });

    Object.assign(state, { actions, contexts, outputs, inputs });
  }

  const state = {
    index: 0,
    logsByIndex: new Map<number, PartialLog>(),
    step: 0,
    ctxState,
    agentCtxState,
    runRef,
    controller: new AbortController(),
    steps: [] as StepRef[],
    chain: [] as AnyRef[],
    actions: [] as ActionCtxRef[],
    outputs: [] as Output[],
    inputs: [] as Input[],
    contexts: [] as ContextState[],
    errors: [] as any[],
    calls: [] as Promise<any>[],
    promises: [] as Promise<any>[],
    response: null as null | string,

    defer: pDefer<AnyRef[]>(),

    params: {} as {
      actions?: AnyAction[];
      outputs?: Record<string, Omit<Output, "type">>;
      contexts?: ContextRef[];
    },

    async setParams(params: {
      actions?: AnyAction[];
      outputs?: Record<string, Omit<Output<any, any, any>, "type">>;
      contexts?: ContextRef[];
    }) {
      state.params = params;
    },

    async start() {
      await prepare();

      await handlePushLog(runRef, true);
      state.step = 1;
      return createStep();
    },

    async nextStep() {
      await prepare();

      state.index++;
      return createStep();
    },

    shouldContinue() {
      if (state.errors.length > 0) {
        logger.warn("agent:run", "Continuing despite error", {
          errors: state.errors,
          step: state.step,
        });
      }

      for (const ctx of state.contexts) {
        if (!ctx.context.shouldContinue) continue;

        if (
          ctx.context.shouldContinue({
            ...ctx,
            workingMemory,
          })
        )
          return true;
      }

      return stepConfig.shouldContinue({ chain: state.chain });
    },
  };

  abortSignal?.addEventListener("abort", () => {
    state.controller.abort(abortSignal?.reason);
  });

  function createErrorEvent({
    name,
    data,
    params,
  }: Pick<EventRef, "name" | "data" | "params">): EventRef {
    return {
      ref: "event",
      id: randomUUIDv7(),
      name,
      data,
      params,
      processed: false,
      timestamp: Date.now(),
    };
  }

  workingMemory.runs.push(runRef);

  function getOrCreateRef<
    TLog extends Omit<PartialLog, "id" | "timestamp" | "processed">,
  >(
    index: number,
    ref: TLog
  ): TLog & Pick<PartialLog, "id" | "timestamp" | "processed"> {
    if (!state.logsByIndex.has(index)) {
      state.logsByIndex.set(index, {
        id: randomUUIDv7(),
        timestamp: Date.now(),
        processed: false,
        ...ref,
      });
    }

    state.index = Math.max(index, state.index);

    return state.logsByIndex.get(index)! as TLog &
      Pick<PartialLog, "id" | "timestamp" | "processed">;
  }

  async function pushLogStream(log: AnyRef, done: boolean) {
    if (log.ref !== "output" && done) state.chain.push(log);

    if (log.ref === "thought" && done) {
      workingMemory.thoughts.push(log);
      logger.debug("agent:think", "thought", log.content);
      handlers?.onThinking?.(log);
    }

    if (log.ref === "input" && done) {
      await handleInput({
        agent,
        ctxState,
        inputRef: log,
        inputs: {
          ...agent.inputs,
          ...ctxState.context.inputs,
        },
        logger,
        workingMemory,
      });

      state.chain.push(log);
      workingMemory.inputs.push(log);
    }

    if (log.ref === "output" && done) {
      await handleOutputStream(log);
    }

    if (log.ref === "event" && done) {
      workingMemory.events.push(log);
    }

    if (log.ref === "action_call" && done) {
      workingMemory.calls.push(log);
      await handleActionCallStream(log);
    }

    if (log.ref === "action_result" && done) {
      workingMemory.results.push(log);

      // Find the most recent thought and action call
      const lastThought =
        workingMemory.thoughts[workingMemory.thoughts.length - 1];
      const lastActionCall =
        workingMemory.calls[workingMemory.calls.length - 1];

      // If we have a complete thought-action-result cycle, generate an episode
      if (lastThought && lastActionCall) {
        // Generate episode with the last thought, action call, and result
        await generateEpisode(
          lastThought,
          lastActionCall,
          log,
          agent,
          ctxState.id,
          state.actions
        ).catch((error) => {
          logger.error(
            "agent:generateEpisode",
            "Failed to generate episode",
            error
          );
        });
      }
    }

    if (done) {
      limitWorkingMemorySize(workingMemory, logger);
      await saveContextWorkingMemory(agent, ctxState.id, workingMemory);
    }

    try {
      handlers?.onLogStream?.(log, done);
    } catch (error) {}

    for (const subscriber of subscriptions) {
      try {
        subscriber(log, done);
      } catch (error) {}
    }
  }

  async function handleActionCallStream(call: ActionCall) {
    const { action, json, templates } = await prepareActionCall({
      call,
      actions: state.actions,
      logger,
    });

    if (abortSignal?.aborted) return;

    if (templates.length > 0)
      await resolveTemplates(
        json,
        templates,
        async function templateResolver(key, path) {
          if (key === "calls") {
            const [index, ...resultPath] = getPathSegments(path);
            const call = resolvePathSegments<Promise<ActionResult>>(
              state.calls,
              [index]
            );
            if (!call) throw new Error("invalid callIndex");
            console.log("waiting for call to finish");
            const results = await call;
            // todo: handle call error
            console.log({ resultPath, results, calls: state.calls });
            const value = resolvePathSegments(results.data, resultPath);
            if (value === undefined) throw new Error("invalid resultPath");
            return value;
          }

          if (key === "shortTermMemory") {
            const shortTermMemory = state.contexts.find(
              (state) => state.context.type === "shortTermMemory"
            );
            if (!shortTermMemory)
              throw new Error("short term memory not found");
            const value = getValueByPath(shortTermMemory.memory, path);
            if (value === undefined)
              throw new Error("invalid short term memory resultPath");
            return value;
          }

          throw new Error("not implemented");
        }
      );

    if (action.schema) {
      const schema =
        "parse" in action.schema || "validate" in action.schema
          ? action.schema
          : z.object(action.schema);

      call.data =
        "parse" in schema
          ? (schema as ZodSchema).parse(json)
          : schema.validate
            ? schema.validate(json)
            : json;
    } else {
      call.data = json;
    }

    state.calls.push(
      handleActionCall({
        call,
        action,
        agent,
        logger,
        state:
          state.contexts.find(
            (subCtxState) => subCtxState.id === action.ctxId
          ) ?? ctxState,
        taskRunner,
        workingMemory,
        agentState: agentCtxState,
        abortSignal,
        pushLog: (log) => handlePushLog(log, true),
      })
        .catch((err) => {
          const result: ActionResult = {
            ref: "action_result",
            id: randomUUIDv7(),
            callId: call.id,
            data: { error: JSON.stringify(err) },
            name: call.name,
            timestamp: Date.now(),
            processed: false,
          };

          return result;
        })
        .then((res) => {
          handlePushLog(res, true);
          return res;
        })
    );
  }

  async function handleOutputStream(outputRef: OutputRef) {
    logger.debug("agent:output", outputRef.type, outputRef.data);

    // Pre-process content that might contain XML tags or non-JSON content
    if (outputRef.type === 'cli:message') {
      try {
        // Check if content is valid JSON
        if (typeof outputRef.content === 'string') {
          const contentStr = outputRef.content.trim();
          // Test if it's already valid JSON
          try {
            JSON.parse(contentStr);
          } catch (e) {
            // If not valid JSON, convert plain text to a message object
            logger.warn("agent:output", "Converting non-JSON content to valid message format", {
              contentPreview: contentStr.substring(0, 30)
            });
            
            // Safely escape any problematic characters
            const safeContent = contentStr
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t');
              
            // Create a valid JSON string with the content as the message
            outputRef.content = `{"message":"${safeContent}"}`;
          }
        }
      } catch (error) {
        // If any error in processing, just use an empty message
        logger.warn("agent:output", "Failed to process cli:message content, using empty message", { error });
        outputRef.content = '{"message":""}';
      }
    }

    try {
      const refs = await handleOutput({
        agent,
        logger,
        state: ctxState,
        workingMemory,
        outputs: state.outputs,
        outputRef,
      });

      for (const ref of Array.isArray(refs) ? refs : [refs]) {
        logger.debug("agent:output", "Output processed status", {
          type: ref.type,
          processed: ref.processed,
        });
        state.chain.push(ref);
        workingMemory.outputs.push(ref);
      }
    } catch (error) {
      // Handle parsing errors for cli:message output type specifically
      if (outputRef.type === "cli:message") {
        logger.warn("agent:output", "Handling error for cli:message", { 
          error: error instanceof Error ? error.message : String(error),
          contentPreview: typeof outputRef.content === 'string' 
            ? outputRef.content.substring(0, 30) 
            : 'non-string content'
        });
        
        // Create a valid cli:message output with empty message
        const fixedOutputRef = {
          ...outputRef,
          data: { message: "" },
          processed: true
        };
        
        state.chain.push(fixedOutputRef);
        workingMemory.outputs.push(fixedOutputRef);
      } else {
        // Rethrow for other cases
        throw error;
      }
    }
  }

  async function handlePushLog(el: AnyRef, done: boolean) {
    try {
      await pushLogStream(el, done);
    } catch (error) {
      state.errors.push(error);
      if (el.ref === "input") return;
      // wip
      if (error instanceof NotFoundError) {
        if (error.ref.ref === "input") return;
        if (error.ref.ref === "output") {
          const outputRef = {
            ...error.ref,
            params: {
              ...error.ref.params,
              id: error.ref.id,
              error: "OutputTypeNotFound",
            },
            processed: false,
          };
          state.chain.push(outputRef);
          workingMemory.outputs.push(outputRef);
        }

        await pushLogStream(
          createErrorEvent({
            name: `error:${error.ref.ref}`,
            data:
              error.ref.ref === "output"
                ? {
                    error: "OutputTypeNotFound",
                    type: error.ref.type ?? "undefined",
                  }
                : { error: "ActionNameNotFound", name: error.ref.name },
            params:
              error.ref.ref === "output"
                ? { outputId: error.ref.id }
                : { callId: error.ref.id },
          }),
          true
        );
      }

      if (error instanceof ParsingError) {
        if (error.ref.ref === "output")
          pushLogStream(
            {
              ...error.ref,
              params: {
                id: error.ref.id,
                error: "parsingError",
              },
            },
            true
          );
        pushLogStream(
          createErrorEvent({
            name: `error:${error.ref.ref}:parsingError`,
            data: error.parsingError,
            params:
              error.ref.ref === "output"
                ? { outputId: error.ref.id }
                : { callId: error.ref.id },
          }),
          true
        );
      }
    }
  }

  function handler(el: StackElement, _: any) {
    if (abortSignal?.aborted) return;

    switch (el.tag) {
      case "think":
      case "thinking":
      case "reasoning": {
        const ref = getOrCreateRef(el.index, {
          ref: "thought",
        });

        handlePushLog(
          {
            ...ref,
            content: el.content,
          },
          el.done
        );

        break;
      }

      case "action_call": {
        const ref = getOrCreateRef(el.index, {
          ref: "action_call",
        });

        handlePushLog(
          {
            ...ref,
            name: el.attributes.name,
            content: el.content,
            data: undefined,
            processed: false,
          },
          el.done
        );

        break;
      }

      case "output": {
        const ref = getOrCreateRef(el.index, {
          ref: "output",
        });

        const { type, ...params } = el.attributes;
        let content = el.content;
        
        // Handle cli:message output specifically
        if (type === "cli:message") {
          try {
            // Check if content is valid JSON
            JSON.parse(content);
          } catch (e) {
            // If not valid JSON, convert content to a valid JSON message
            const safeContent = content
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t');
              
            content = `{"message":"${safeContent}"}`;
          }
        }
        // For other output types that might have XML content
        else if (content.includes('</') || content.includes('/>') || 
                (content.includes('<') && content.match(/<[a-zA-Z]/))) {
          logger.warn("agent:output", "Found XML content in output, sanitizing", { type });
          content = "{}"; // Default to empty JSON object
        }

        handlePushLog(
          {
            ...ref,
            type,
            params,
            content,
            data: undefined,
          },
          el.done
        );

        break;
      }

      default:
        break;
    }
  }

  return {
    state,
    handler,
    push: handlePushLog,
    tags: defaultTags,
    stepConfig: stepConfig,
  };
}

function limitWorkingMemorySize(workingMemory: WorkingMemory, logger?: Logger) {
  // Clear steps
  workingMemory.steps = [];
  
  // Keep only 3 latest runs
  if (workingMemory.runs.length > 3) {
    workingMemory.runs = workingMemory.runs.slice(-3);
  }
  
  // Keep only 1 latest inputs and outputs
  if (workingMemory.inputs.length > 1) {
    workingMemory.inputs = workingMemory.inputs.slice(-1);
  }
  if (workingMemory.outputs.length > 1) {
    workingMemory.outputs = workingMemory.outputs.slice(-1);
  }
  
  // Keep only 5 latest calls and results
  if (workingMemory.calls.length > 5) {
    workingMemory.calls = workingMemory.calls.slice(-5);
  }
  if (workingMemory.results.length > 5) {
    workingMemory.results = workingMemory.results.slice(-5);
  }
  
  // Limit events to 3 most recent entries
  if (workingMemory.events.length > 3) {  
    workingMemory.events = workingMemory.events.slice(-3);
  }
  
  // Limit thoughts to 50 most recent entries
  if (workingMemory.thoughts.length > 50) {
    workingMemory.thoughts = workingMemory.thoughts.slice(-50);
  }

  // Log the final sizes if logger is available
  if (logger) {
    logger.debug("memory:limit", "Working memory size after limiting", {
      finalSizes: {
        steps: workingMemory.steps.length,
        runs: workingMemory.runs.length,
        inputs: workingMemory.inputs.length,
        outputs: workingMemory.outputs.length,
        calls: workingMemory.calls.length,
        results: workingMemory.results.length,
        thoughts: workingMemory.thoughts.length,
        events: workingMemory.events.length
      }
    });
  }
}
