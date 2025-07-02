import {
  smoothStream,
  streamText,
  type CoreMessage,
  type LanguageModelV1,
  type StreamTextResult,
  type ToolSet,
} from "ai";
import { task } from "../task";
import type {
  Action,
  ActionCallContext,
  AnyAction,
  AnyAgent,
  AnyContext,
  WorkingMemory,
} from "../types";
import type { Logger } from "../logger";
import { wrapStream } from "../streaming";

type ModelConfig = {
  assist?: boolean;
  prefix?: string;
  thinkTag?: string;
};

// TODO: move this
export const modelsResponseConfig: Record<string, ModelConfig> = {
  "o3-mini": {
    assist: false,
    prefix: "",
  },
  "claude-3-7-sonnet-20250219": {
    // assist: true,
    // prefix: "<thinking>",
    // thinkTag: "<thinking>",
  },
  "qwen-qwq-32b": {
    prefix: "",
  },
  "google/gemini-2.0-flash-001": {
    // prefix: "",
  },
  "deepseek-r1-distill-llama-70b": {
    prefix: "",
    assist: false,
  },
};

export const reasoningModels = [
  "claude-3-7-sonnet-20250219",
  "qwen-qwq-32b",
  "deepseek-r1-distill-llama-70b",
  "o3-mini",
  "google/gemini-2.0-flash-001",
  "google/gemini-2.0-flash-lite-preview-02-05:free",
];

/**
 * Prepares a stream response by handling the stream result and parsing it.
 *
 * @param options - Configuration options
 * @param options.contextId - The ID of the context
 * @param options.step - The current step in the process
 * @param options.stream - The stream result to process
 * @param options.logger - The logger instance
 * @param options.task - The task context containing callId and debug function
 * @returns An object containing the parsed response promise and wrapped text stream
 */
function prepareStreamResponse({
  model,
  stream,
  isReasoningModel,
}: {
  model: LanguageModelV1;
  stream: StreamTextResult<ToolSet, never>;
  isReasoningModel: boolean;
}) {
  const prefix =
    modelsResponseConfig[model.modelId]?.prefix ??
    (isReasoningModel
      ? (modelsResponseConfig[model.modelId]?.thinkTag ?? "<think>")
      : "<response>");
  const suffix = "</response>";
  return {
    getTextResponse: async () => {
      const result = await stream.text;
      const text = prefix + result + suffix;
      return text;
    },
    stream: wrapStream(stream.textStream, prefix, suffix),
  };
}

type GenerateOptions = {
  prompt: string;
  workingMemory: WorkingMemory;
  logger: Logger;
  model: LanguageModelV1;
  onError: (error: unknown) => void;
  abortSignal?: AbortSignal;
};

export const runGenerate = task(
  "agent:run:generate",
  async (
    { prompt, workingMemory, model, onError, abortSignal }: GenerateOptions,
    { callId, debug }
  ) => {
    const isReasoningModel = reasoningModels.includes(model.modelId);

    const messages: CoreMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
        ],
      },
    ];

    if (modelsResponseConfig[model.modelId]?.assist !== false)
      messages.push({
        role: "assistant",
        content: isReasoningModel
          ? (modelsResponseConfig[model.modelId]?.thinkTag ?? "<think>")
          : "<response>",
      });

    if (workingMemory.currentImage) {
      messages[0].content = [
        ...messages[0].content,
        {
          type: "image",
          image: workingMemory.currentImage,
        },
      ] as CoreMessage["content"];
    }

    try {
    // GROK MODEL COMPATIBILITY FIX:
    // Grok models use a different parameter name for stop sequences.
    // While most AI SDK models use 'stopSequences', Grok expects 'stop'.
    // We detect Grok models by checking if 'grok' is in the model ID.
    const isGrokModel = model.modelId.toLowerCase().includes('grok');
    
    // BUILD STREAM OPTIONS OBJECT:
    // Create the base configuration object that will be passed to streamText.
    // Using 'any' type to allow dynamic property assignment for stop parameters.
    const streamOptions: any = {
      model,
      messages,
      temperature: 0.6,
      abortSignal,
      // ERROR HANDLING:
      // Type the onError callback properly to satisfy TypeScript.
      // The event object contains an 'error' property of unknown type.
      onError: (event: { error: unknown }) => {
          console.log({ event });
        onError(event.error);
      },
    };

    // CONDITIONAL STOP PARAMETER ASSIGNMENT:
    // Dynamically add the correct stop sequence parameter based on the model type.
    // This ensures compatibility across different AI providers and models.
    if (isGrokModel) {
      // Grok models expect 'stop' parameter
      streamOptions.stop = ["\n</response>"];
    } else {
      // Standard AI SDK models expect 'stopSequences' parameter
      streamOptions.stopSequences = ["\n</response>"];
    }

    // EXECUTE STREAM WITH MODEL-SPECIFIC PARAMETERS:
    // Call streamText with the dynamically constructed options object
    const stream = streamText(streamOptions);

    return prepareStreamResponse({
      model,
      stream,
      isReasoningModel,
    });
    } catch (error) {
      console.log({ error });
      throw error;
    }
  }
);

/**
 * Task that executes an action with the given context and parameters.
 *
 * @param options - Configuration options
 * @param options.ctx - The agent context with memory
 * @param options.action - The action to execute
 * @param options.call - The action call details
 * @param options.agent - The agent instance
 * @param options.logger - The logger instance
 * @returns The result of the action execution
 * @throws Will throw an error if the action execution fails
 */
export const runAction = task(
  "agent:run:action",
  async <TContext extends AnyContext>({
    ctx,
    action,
    agent,
    logger,
  }: {
    ctx: ActionCallContext<any, TContext>;
    action: AnyAction;
    agent: AnyAgent;
    logger: Logger;
  }) => {
    logger.info(
      "agent:action_call:" + ctx.call.id,
      ctx.call.name,
      JSON.stringify(ctx.call.data)
    );

    try {
      const result =
        action.schema === undefined
          ? await Promise.try((action as Action<undefined>).handler, ctx, agent)
          : await Promise.try(action.handler as any, ctx.call.data, ctx, agent);

      logger.debug("agent:action_result:" + ctx.call.id, ctx.call.name, result);
      return result;
    } catch (error) {
      logger.error("agent:action", "ACTION_FAILED", { error });

      if (action.onError) {
        await Promise.try(action.onError, error, ctx, agent);
      } else {
        throw error;
      }
    }
  }
);
