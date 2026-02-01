/**
 * 钉钉消息处理
 *
 * 实现消息解析、策略检查和 Agent 分发
 */

import type { DingtalkRawMessage, DingtalkMessageContext } from "./types.js";
import type { DingtalkConfig } from "./config.js";
import { getDingtalkRuntime, isDingtalkRuntimeInitialized } from "./runtime.js";
import { sendMessageDingtalk } from "./send.js";
import {
  sendMediaDingtalk,
  extractFileFromMessage,
  downloadDingTalkFile,
  parseRichTextMessage,
  downloadRichTextImages,
  cleanupFile,
  type DownloadedFile,
  type ExtractedFileInfo,
  type MediaMsgType,
} from "./media.js";
import { getAccessToken } from "./client.js";
import { createAICard, streamAICard, finishAICard, type AICardInstance } from "./card.js";
import { createLogger, type Logger, checkDmPolicy, checkGroupPolicy, resolveFileCategory } from "@openclaw-china/shared";

/**
 * 解析钉钉原始消息为标准化的消息上下文
 * 
 * @param raw 钉钉原始消息对象
 * @returns 解析后的消息上下�?
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */
export function parseDingtalkMessage(raw: DingtalkRawMessage): DingtalkMessageContext {
  // 根据 conversationType 判断聊天类型
  // "1" = 单聊 (direct), "2" = 群聊 (group)
  const chatType = raw.conversationType === "2" ? "group" : "direct";
  
  // 提取消息内容
  let content = "";
  
  if (raw.msgtype === "text" && raw.text?.content) {
    // 文本消息：提�?text.content
    content = raw.text.content.trim();
  } else if (raw.msgtype === "audio" && raw.content) {
    // 音频消息：提取语音识别文�?content.recognition
    // content 可能是字符串或对象，需要处�?
    const contentObj = typeof raw.content === "string" 
      ? (() => { try { return JSON.parse(raw.content); } catch { return null; } })()
      : raw.content;
    if (contentObj && typeof contentObj === "object" && "recognition" in contentObj && typeof contentObj.recognition === "string") {
      content = contentObj.recognition.trim();
    }
  }
  
  // 检查是�?@提及了机器人
  const mentionedBot = resolveMentionedBot(raw);
  
  // 使用 Stream 消息 ID（如果可用），确保去重稳�?
  const messageId = raw.streamMessageId ?? `${raw.conversationId}_${Date.now()}`;
  
  const senderId =
    raw.senderStaffId ??
    raw.senderUserId ??
    raw.senderUserid ??
    raw.senderId;

  return {
    conversationId: raw.conversationId,
    messageId,
    senderId,
    senderNick: raw.senderNick,
    chatType,
    content,
    contentType: raw.msgtype,
    mentionedBot,
    robotCode: raw.robotCode,
  };
}

/**
 * 判断是否 @提及了机器人
 *
 * 钉钉群聊机器人只有被 @ 才会收到消息，因此只要 atUsers 数组非空，
 * 就认为机器人被提及。不需要检查 robotCode 是否在 atUsers 中，
 * 因为钉钉 Stream SDK 只会将 @ 机器人的消息推送给机器人。
 */
function resolveMentionedBot(raw: DingtalkRawMessage): boolean {
  const atUsers = raw.atUsers ?? [];
  return atUsers.length > 0;
}

/**
 * 入站消息上下�?
 * 用于传递给 Moltbot 核心的标准化上下�?
 */
export interface InboundContext {
  /** 消息正文 */
  Body: string;
  /** 原始消息正文 */
  RawBody: string;
  /** 命令正文 */
  CommandBody: string;
  /** 发送方标识 */
  From: string;
  /** 接收方标�?*/
  To: string;
  /** 会话�?*/
  SessionKey: string;
  /** 账户 ID */
  AccountId: string;
  /** 聊天类型 */
  ChatType: "direct" | "group";
  /** 群组主题（群聊时�?*/
  GroupSubject?: string;
  /** 发送者名�?*/
  SenderName?: string;
  /** 发送�?ID */
  SenderId: string;
  /** 渠道提供�?*/
  Provider: "dingtalk";
  /** 消息 ID */
  MessageSid: string;
  /** 时间�?*/
  Timestamp: number;
  /** 是否�?@提及 */
  WasMentioned: boolean;
  /** 命令是否已授�?*/
  CommandAuthorized: boolean;
  /** 原始渠道 */
  OriginatingChannel: "dingtalk";
  /** 原始接收�?*/
  OriginatingTo: string;
  
  // ===== 媒体相关字段 (Requirements 7.1-7.8) =====
  
  /** 单个媒体文件的本地绝对路�?*/
  MediaPath?: string;
  /** 单个媒体文件�?MIME 类型 (�?"image/jpeg") */
  MediaType?: string;
  /** 多个媒体文件的本地绝对路径数�?(用于 richText 消息) */
  MediaPaths?: string[];
  /** 多个媒体文件�?MIME 类型数组 (用于 richText 消息) */
  MediaTypes?: string[];
  /** 原始文件�?(用于 file 消息) */
  FileName?: string;
  /** 文件大小（字节）(用于 file 消息) */
  FileSize?: number;
  /** 语音识别文本 (用于 audio 消息) */
  Transcript?: string;
}

/**
 * 构建入站消息上下�?
 * 
 * @param ctx 解析后的消息上下�?
 * @param sessionKey 会话�?
 * @param accountId 账户 ID
 * @returns 入站消息上下�?
 * 
 * Requirements: 6.4
 */
export function buildInboundContext(
  ctx: DingtalkMessageContext,
  sessionKey: string,
  accountId: string,
): InboundContext {
  const isGroup = ctx.chatType === "group";
  
  // 构建 From �?To 标识
  const from = isGroup
    ? `dingtalk:group:${ctx.conversationId}`
    : `dingtalk:${ctx.senderId}`;
  const to = isGroup
    ? `chat:${ctx.conversationId}`
    : `user:${ctx.senderId}`;
  
  return {
    Body: ctx.content,
    RawBody: ctx.content,
    CommandBody: ctx.content,
    From: from,
    To: to,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: ctx.chatType,
    GroupSubject: isGroup ? ctx.conversationId : undefined,
    SenderName: ctx.senderNick,
    SenderId: ctx.senderId,
    Provider: "dingtalk",
    MessageSid: ctx.messageId,
    Timestamp: Date.now(),
    WasMentioned: ctx.mentionedBot,
    CommandAuthorized: true,
    OriginatingChannel: "dingtalk",
    OriginatingTo: to,
  };
}

/**
 * 处理 AI Card 流式响应
 * 
 * 通过 Moltbot 核心 API 获取 LLM 响应，并流式更新 AI Card
 * 
 * @param params 处理参数
 * @returns Promise<void>
 */
async function handleAICardStreaming(params: {
  card: AICardInstance;
  cfg: unknown;
  route: { sessionKey: string; accountId: string; agentId?: string };
  inboundCtx: InboundContext;
  dingtalkCfg: DingtalkConfig;
  targetId: string;
  chatType: "direct" | "group";
  logger: Logger;
}): Promise<void> {
  const { card, cfg, route, inboundCtx, dingtalkCfg, targetId, chatType, logger } = params;
  let accumulated = "";

  try {
    const core = getDingtalkRuntime();
    let lastUpdateTime = 0;
    const updateInterval = 300; // 最小更新间�?ms

    // 创建回复分发�?
    const coreChannel = (core as Record<string, unknown>)?.channel as Record<string, unknown> | undefined;
    const replyApi = coreChannel?.reply as Record<string, unknown> | undefined;

    const humanDelay = (replyApi?.resolveHumanDelayConfig as ((cfg: unknown, agentId?: string) => unknown) | undefined)?.(
      cfg,
      route.agentId
    );

    const createDispatcherWithTyping = replyApi?.createReplyDispatcherWithTyping as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;
    const createDispatcher = replyApi?.createReplyDispatcher as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;

    const dispatcherResult = createDispatcherWithTyping
      ? createDispatcherWithTyping({
          deliver: async (payload: unknown) => {
            let text = "";
            if (typeof payload === "object" && payload !== null && "text" in payload) {
              const textValue = (payload as Record<string, unknown>)["text"];
              text = typeof textValue === "string" ? textValue : "";
            }
            if (!text.trim()) return;

            accumulated += text;

            // 节流更新，避免过于频�?
            const now = Date.now();
            if (now - lastUpdateTime >= updateInterval) {
              await streamAICard(card, accumulated, false, (msg) => logger.debug(msg));
              lastUpdateTime = now;
            }
          },
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        })
      : {
          dispatcher: createDispatcher?.({
            deliver: async (payload: unknown) => {
              let text = "";
              if (typeof payload === "object" && payload !== null && "text" in payload) {
                const textValue = (payload as Record<string, unknown>)["text"];
                text = typeof textValue === "string" ? textValue : "";
              }
              if (!text.trim()) return;

              accumulated += text;

              const now = Date.now();
              if (now - lastUpdateTime >= updateInterval) {
                await streamAICard(card, accumulated, false, (msg) => logger.debug(msg));
                lastUpdateTime = now;
              }
            },
            humanDelay,
            onError: (err: unknown, info: { kind: string }) => {
              logger.error(`${info.kind} reply failed: ${String(err)}`);
            },
          }),
          replyOptions: {},
          markDispatchIdle: () => undefined,
        };

    const dispatcher = (dispatcherResult as Record<string, unknown>)?.dispatcher as Record<string, unknown> | undefined;
    if (!dispatcher) {
      logger.debug("dispatcher not available");
      return;
    }

    // 分发消息
    const dispatchReplyFromConfig = replyApi?.dispatchReplyFromConfig as
      | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | undefined;

    if (!dispatchReplyFromConfig) {
      logger.debug("dispatchReplyFromConfig not available");
      return;
    }

    const result = await dispatchReplyFromConfig({
      ctx: inboundCtx,
      cfg,
      dispatcher,
      replyOptions: (dispatcherResult as Record<string, unknown>)?.replyOptions ?? {},
    });

    const markDispatchIdle = (dispatcherResult as Record<string, unknown>)?.markDispatchIdle as (() => void) | undefined;
    markDispatchIdle?.();

    const counts = (result as Record<string, unknown>)?.counts as Record<string, unknown> | undefined;
    logger.debug(`dispatch complete (replies=${counts?.final ?? 0})`);

    // 完成卡片
    await finishAICard(card, accumulated, (msg) => logger.debug(msg));
    logger.info(`AI Card streaming completed with ${accumulated.length} chars`);
  } catch (err) {
    logger.error(`AI Card streaming failed: ${String(err)}`);
    // 尝试用错误信息完成卡�?
    try {
      const errorMsg = `⚠️ Response interrupted: ${String(err)}`;
      await finishAICard(card, errorMsg, (msg) => logger.debug(msg));
    } catch (finishErr) {
      logger.error(`Failed to finish card with error: ${String(finishErr)}`);
    }

    // 回退到普通消息发送（使用钉钉 SDK�?
    try {
      const fallbackText = accumulated.trim()
        ? accumulated
        : `⚠️ Response interrupted: ${String(err)}`;
      const limit = dingtalkCfg.textChunkLimit ?? 4000;
      for (let i = 0; i < fallbackText.length; i += limit) {
        const chunk = fallbackText.slice(i, i + limit);
        await sendMessageDingtalk({
          cfg: dingtalkCfg,
          to: targetId,
          text: chunk,
          chatType,
        });
      }
      logger.info("AI Card failed; fallback message sent via SDK");
    } catch (fallbackErr) {
      logger.error(`Failed to send fallback message: ${String(fallbackErr)}`);
    }
  }
}

/**
 * 构建文件上下文消�?
 * 
 * 根据文件类型返回对应的中文描述文�?
 * 
 * @param msgType 消息类型 (picture, video, audio, file)
 * @param fileName 文件名（可选，用于 file 类型�?
 * @returns 消息正文描述
 * 
 * Requirements: 9.5
 */
export function buildFileContextMessage(
  msgType: MediaMsgType,
  fileName?: string
): string {
  switch (msgType) {
    case "picture":
      return "[图片]";
    case "audio":
      return "[语音消息]";
    case "video":
      return "[视频]";
    case "file": {
      // 根据文件扩展名确定文件类�?
      const displayName = fileName ?? "未知文件";
      
      if (fileName) {
        // 使用 resolveFileCategory 来确定文件类�?
        const category = resolveFileCategory("application/octet-stream", fileName);
        
        switch (category) {
          case "document":
            return `[文档: ${displayName}]`;
          case "archive":
            return `[压缩�? ${displayName}]`;
          case "code":
            return `[代码文件: ${displayName}]`;
          default:
            return `[文件: ${displayName}]`;
        }
      }
      
      return `[文件: ${displayName}]`;
    }
    default:
      return `[文件: ${fileName ?? "未知文件"}]`;
  }
}


/**
 * 处理钉钉入站消息
 * 
 * 集成消息解析、策略检查和 Agent 分发
 * 
 * @param params 处理参数
 * @returns Promise<void>
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */
export async function handleDingtalkMessage(params: {
  cfg: unknown; // ClawdbotConfig
  raw: DingtalkRawMessage;
  accountId?: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  enableAICard?: boolean;
}): Promise<void> {
  const {
    cfg,
    raw,
    accountId = "default",
    enableAICard = false,
  } = params;
  
  // 创建日志�?
  const logger: Logger = createLogger("dingtalk", {
    log: params.log,
    error: params.error,
  });
  
  // 解析消息
  const ctx = parseDingtalkMessage(raw);
  const isGroup = ctx.chatType === "group";
  
  // 添加详细的原始消息调试日志
  logger.debug(`raw message: msgtype=${raw.msgtype}, hasText=${!!raw.text?.content}, hasContent=${!!raw.content}, textContent="${raw.text?.content ?? ""}"`);
  
  // 对于 richText 消息，输出完整的原始消息结构以便调试
  if (raw.msgtype === "richText") {
    try {
      // 安全地序列化原始消息（排除可能的循环引用）
      const safeRaw = {
        msgtype: raw.msgtype,
        conversationId: raw.conversationId,
        conversationType: raw.conversationType,
        senderId: raw.senderId,
        senderNick: raw.senderNick,
        text: raw.text,
        content: raw.content,
        // 检查是否有其他可能包含文本的字段
        hasRichTextInRoot: "richText" in raw,
        allKeys: Object.keys(raw),
      };
      logger.debug(`[FULL RAW] richText message structure: ${JSON.stringify(safeRaw)}`);
    } catch (e) {
      logger.debug(`[FULL RAW] failed to serialize: ${String(e)}`);
    }
  }
  
  logger.debug(`received message from ${ctx.senderId} in ${ctx.conversationId} (${ctx.chatType})`);
  
  // 获取钉钉配置
  const dingtalkCfg = (cfg as Record<string, unknown>)?.channels as Record<string, unknown> | undefined;
  const channelCfg = dingtalkCfg?.dingtalk as DingtalkConfig | undefined;
  
  // 策略检�?
  if (isGroup) {
    const groupPolicy = channelCfg?.groupPolicy ?? "allowlist";
    const groupAllowFrom = channelCfg?.groupAllowFrom ?? [];
    const requireMention = channelCfg?.requireMention ?? true;
    
    const policyResult = checkGroupPolicy({
      groupPolicy,
      conversationId: ctx.conversationId,
      groupAllowFrom,
      requireMention,
      mentionedBot: ctx.mentionedBot,
    });
    
    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  } else {
    const dmPolicy = channelCfg?.dmPolicy ?? "pairing";
    const allowFrom = channelCfg?.allowFrom ?? [];
    
    const policyResult = checkDmPolicy({
      dmPolicy,
      senderId: ctx.senderId,
      allowFrom,
    });
    
    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  }
  
  // 检查运行时是否已初始化
  if (!isDingtalkRuntimeInitialized()) {
    logger.warn("runtime not initialized, skipping dispatch");
    return;
  }
  
  // ===== 媒体消息处理变量 (�?try 块外声明以便 catch 块访�? =====
  let downloadedMedia: DownloadedFile | null = null;
  let downloadedRichTextImages: DownloadedFile[] = [];
  let extractedFileInfo: ExtractedFileInfo | null = null;
  
  try {
    // 获取完整�?Moltbot 运行时（包含 core API�?
    const core = getDingtalkRuntime();
    const coreRecord = core as Record<string, unknown>;
    const coreChannel = coreRecord?.channel as Record<string, unknown> | undefined;
    const replyApi = coreChannel?.reply as Record<string, unknown> | undefined;
    const routingApi = coreChannel?.routing as Record<string, unknown> | undefined;
    
    // 检查必要的 API 是否存在
    if (!routingApi?.resolveAgentRoute) {
      logger.debug("core.channel.routing.resolveAgentRoute not available, skipping dispatch");
      return;
    }
    
    if (!replyApi?.dispatchReplyFromConfig) {
      logger.debug("core.channel.reply.dispatchReplyFromConfig not available, skipping dispatch");
      return;
    }

    if (!replyApi?.createReplyDispatcher && !replyApi?.createReplyDispatcherWithTyping) {
      logger.debug("core.channel.reply dispatcher factory not available, skipping dispatch");
      return;
    }
    
    // 解析路由
    const resolveAgentRoute = routingApi.resolveAgentRoute as (opts: Record<string, unknown>) => Record<string, unknown>;
    const route = resolveAgentRoute({
      cfg,
      channel: "dingtalk",
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? ctx.conversationId : ctx.senderId,
      },
    });
    
    // ===== 媒体消息处理 (Requirements 9.1, 9.2, 9.4, 9.6) =====
    // 用于存储下载的媒体文件信�?
    let mediaBody: string | null = null;
    let richTextParseResult: ReturnType<typeof parseRichTextMessage> = null;
    
    // 检测并处理媒体消息类型 (picture, video, audio, file)
    const mediaTypes: MediaMsgType[] = ["picture", "video", "audio", "file"];
    if (mediaTypes.includes(raw.msgtype as MediaMsgType)) {
      try {
        // 提取文件信息 (Requirement 9.1)
        extractedFileInfo = extractFileFromMessage(raw);
        
        if (extractedFileInfo && channelCfg?.clientId && channelCfg?.clientSecret) {
          // 获取 access token (Requirement 9.6)
          const accessToken = await getAccessToken(channelCfg.clientId, channelCfg.clientSecret);
          
          // 下载文件 (Requirement 9.2)
          downloadedMedia = await downloadDingTalkFile({
            downloadCode: extractedFileInfo.downloadCode,
            robotCode: channelCfg.clientId,
            accessToken,
            fileName: extractedFileInfo.fileName,
            msgType: extractedFileInfo.msgType,
            log: logger,
          });
          
          logger.debug(`downloaded media file: ${downloadedMedia.path} (${downloadedMedia.size} bytes)`);
          
          // 构建消息正文 (Requirement 9.5)
          mediaBody = buildFileContextMessage(
            extractedFileInfo.msgType,
            extractedFileInfo.fileName
          );
        }
      } catch (err) {
        // 优雅降级：记录警告并继续处理文本内容 (Requirement 9.4)
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`media download failed, continuing with text: ${errorMessage}`);
        downloadedMedia = null;
        extractedFileInfo = null;
      }
    }
    
    // ===== richText 消息处理 (Requirements 9.3, 3.6) =====
    if (raw.msgtype === "richText") {
      try {
        // 解析 richText 消息
        richTextParseResult = parseRichTextMessage(raw);
        
        if (richTextParseResult && channelCfg?.clientId && channelCfg?.clientSecret) {
          // 检查是否有图片需要下�?(Requirement 3.6)
          if (richTextParseResult.imageCodes.length > 0) {
            // 获取 access token
            const accessToken = await getAccessToken(channelCfg.clientId, channelCfg.clientSecret);
            
            // 批量下载图片
            downloadedRichTextImages = await downloadRichTextImages({
              imageCodes: richTextParseResult.imageCodes,
              robotCode: channelCfg.clientId,
              accessToken,
              log: logger,
            });
            
            logger.debug(`downloaded ${downloadedRichTextImages.length}/${richTextParseResult.imageCodes.length} richText images`);
          }
          
          // 设置消息正文为拼接的文本
          if (richTextParseResult.textParts.length > 0) {
            mediaBody = richTextParseResult.textParts.join("\n");
          } else if (downloadedRichTextImages.length > 0) {
            // 如果只有图片没有文本，设置为图片描述
            mediaBody = downloadedRichTextImages.length === 1 
              ? "[图片]" 
              : `[${downloadedRichTextImages.length}张图片]`;
          }
        }
      } catch (err) {
        // 优雅降级：记录警告并继续处理
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`richText processing failed: ${errorMessage}`);
        richTextParseResult = null;
        downloadedRichTextImages = [];
      }
    }
    
    // 构建入站上下�?
    const inboundCtx = buildInboundContext(ctx, (route as Record<string, unknown>)?.sessionKey as string, (route as Record<string, unknown>)?.accountId as string);
    
    // 设置媒体相关字段 (Requirements 7.1-7.8)
    if (downloadedMedia) {
      inboundCtx.MediaPath = downloadedMedia.path;
      inboundCtx.MediaType = downloadedMedia.contentType;
      
      // 设置消息正文为媒体描�?
      if (mediaBody) {
        inboundCtx.Body = mediaBody;
        inboundCtx.RawBody = mediaBody;
        inboundCtx.CommandBody = mediaBody;
      }
      
      // 文件消息特有字段
      if (extractedFileInfo?.msgType === "file") {
        if (extractedFileInfo.fileName) {
          inboundCtx.FileName = extractedFileInfo.fileName;
        }
        if (extractedFileInfo.fileSize !== undefined) {
          inboundCtx.FileSize = extractedFileInfo.fileSize;
        }
      }
      
      // 音频消息的语音识别文�?
      if (extractedFileInfo?.msgType === "audio" && extractedFileInfo.recognition) {
        inboundCtx.Transcript = extractedFileInfo.recognition;
      }
    }
    
    // 设置 richText 消息的媒体字�?(Requirements 7.3, 7.4)
    if (downloadedRichTextImages.length > 0) {
      inboundCtx.MediaPaths = downloadedRichTextImages.map(f => f.path);
      inboundCtx.MediaTypes = downloadedRichTextImages.map(f => f.contentType);
      
      // 设置消息正文
      if (mediaBody) {
        inboundCtx.Body = mediaBody;
        inboundCtx.RawBody = mediaBody;
        inboundCtx.CommandBody = mediaBody;
      }
    } else if (richTextParseResult && richTextParseResult.textParts.length > 0) {
      // 纯文�?richText 消息 (Requirement 3.6)
      // 不设�?MediaPath/MediaType，只设置 Body
      const textBody = richTextParseResult.textParts.join("\n");
      inboundCtx.Body = textBody;
      inboundCtx.RawBody = textBody;
      inboundCtx.CommandBody = textBody;
    }

    // 如果�?finalizeInboundContext，使用它
    const finalizeInboundContext = replyApi?.finalizeInboundContext as ((ctx: InboundContext) => InboundContext) | undefined;
    const finalCtx = finalizeInboundContext ? finalizeInboundContext(inboundCtx) : inboundCtx;

    const dingtalkCfgResolved = channelCfg;
    if (!dingtalkCfgResolved) {
      logger.warn("channel config missing, skipping dispatch");
      return;
    }

    // ===== AI Card 流式处理 =====
    if (enableAICard) {
      const card = await createAICard({
        cfg: dingtalkCfgResolved,
        conversationType: ctx.chatType === "group" ? "2" : "1",
        conversationId: ctx.conversationId,
        senderId: ctx.senderId,
        senderStaffId: raw.senderStaffId,
        log: (msg) => logger.debug(msg),
      });

      if (card) {
        logger.info("AI Card created, using streaming mode");
        await handleAICardStreaming({
          card,
          cfg,
          route: route as { sessionKey: string; accountId: string; agentId?: string },
          inboundCtx: finalCtx,
          dingtalkCfg: dingtalkCfgResolved,
          targetId: isGroup ? ctx.conversationId : ctx.senderId,
          chatType: isGroup ? "group" : "direct",
          logger,
        });
        return;
      } else {
        logger.warn("AI Card creation failed, falling back to normal message");
      }
    }

    // ===== 普通消息模�?=====
    const textApi = coreChannel?.text as Record<string, unknown> | undefined;
    
    const textChunkLimitResolved =
      (textApi?.resolveTextChunkLimit as ((opts: Record<string, unknown>) => number) | undefined)?.(
        {
          cfg,
          channel: "dingtalk",
          defaultLimit: dingtalkCfgResolved.textChunkLimit ?? 4000,
        }
      ) ?? (dingtalkCfgResolved.textChunkLimit ?? 4000);
    const chunkMode = (textApi?.resolveChunkMode as ((cfg: unknown, channel: string) => unknown) | undefined)?.(cfg, "dingtalk");
    const tableMode = "bullets";

    const deliver = async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
      const targetId = isGroup ? ctx.conversationId : ctx.senderId;
      const chatType = isGroup ? "group" : "direct";

      const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      if (mediaUrls.length > 0) {
        for (const mediaUrl of mediaUrls) {
          await sendMediaDingtalk({
            cfg: dingtalkCfgResolved,
            to: targetId,
            mediaUrl,
            chatType,
          });
        }
        return;
      }

      const rawText = payload.text ?? "";
      if (!rawText.trim()) return;
      
      const converted = (textApi?.convertMarkdownTables as ((text: string, mode: string) => string) | undefined)?.(
        rawText,
        tableMode
      ) ?? rawText;
      
      const chunks =
        textApi?.chunkTextWithMode && typeof textChunkLimitResolved === "number" && textChunkLimitResolved > 0
          ? (textApi.chunkTextWithMode as (text: string, limit: number, mode: unknown) => string[])(converted, textChunkLimitResolved, chunkMode)
          : [converted];

      for (const chunk of chunks) {
        await sendMessageDingtalk({
          cfg: dingtalkCfgResolved,
          to: targetId,
          text: chunk,
          chatType,
        });
      }
    };

    const humanDelay = (replyApi?.resolveHumanDelayConfig as ((cfg: unknown, agentId?: string) => unknown) | undefined)?.(
      cfg,
      (route as Record<string, unknown>)?.agentId as string | undefined
    );

    const createDispatcherWithTyping = replyApi?.createReplyDispatcherWithTyping as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;
    const createDispatcher = replyApi?.createReplyDispatcher as
      | ((opts: Record<string, unknown>) => Record<string, unknown>)
      | undefined;

    const dispatcherResult = createDispatcherWithTyping
      ? createDispatcherWithTyping({
          deliver: async (payload: unknown) => {
            await deliver(payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] });
          },
          humanDelay,
          onError: (err: unknown, info: { kind: string }) => {
            logger.error(`${info.kind} reply failed: ${String(err)}`);
          },
        })
      : {
          dispatcher: createDispatcher?.({
            deliver: async (payload: unknown) => {
              await deliver(payload as { text?: string; mediaUrl?: string; mediaUrls?: string[] });
            },
            humanDelay,
            onError: (err: unknown, info: { kind: string }) => {
              logger.error(`${info.kind} reply failed: ${String(err)}`);
            },
          }),
          replyOptions: {},
          markDispatchIdle: () => undefined,
        };

    const dispatcher = (dispatcherResult as Record<string, unknown>)?.dispatcher as Record<string, unknown> | undefined;
    if (!dispatcher) {
      logger.debug("dispatcher not available, skipping dispatch");
      return;
    }

    logger.debug(`dispatching to agent (session=${(route as Record<string, unknown>)?.sessionKey})`);

    // 分发消息
    const dispatchReplyFromConfig = replyApi?.dispatchReplyFromConfig as
      | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | undefined;

    if (!dispatchReplyFromConfig) {
      logger.debug("dispatchReplyFromConfig not available");
      return;
    }

    const result = await dispatchReplyFromConfig({
      ctx: finalCtx,
      cfg,
      dispatcher,
      replyOptions: (dispatcherResult as Record<string, unknown>)?.replyOptions ?? {},
    });

    const markDispatchIdle = (dispatcherResult as Record<string, unknown>)?.markDispatchIdle as (() => void) | undefined;
    markDispatchIdle?.();

    const counts = (result as Record<string, unknown>)?.counts as Record<string, unknown> | undefined;
    logger.debug(`dispatch complete (replies=${counts?.final ?? 0})`);
    
    // ===== 文件清理 (Requirements 8.1, 8.2, 8.4) =====
    // 清理单个媒体文件
    if (downloadedMedia && extractedFileInfo) {
      const category = resolveFileCategory(downloadedMedia.contentType, extractedFileInfo.fileName);
      
      // 图片/音频/视频立即删除 (Requirement 8.1)
      // 文档/压缩�?代码文件保留�?agent 工具访问 (Requirement 8.2)
      if (category === "image" || category === "audio" || category === "video") {
        await cleanupFile(downloadedMedia.path, logger);
        logger.debug(`cleaned up media file: ${downloadedMedia.path}`);
      } else {
        logger.debug(`retaining file for agent access: ${downloadedMedia.path} (category: ${category})`);
      }
    }
    
    // 清理 richText 图片 (Requirement 8.4)
    for (const img of downloadedRichTextImages) {
      await cleanupFile(img.path, logger);
    }
    if (downloadedRichTextImages.length > 0) {
      logger.debug(`cleaned up ${downloadedRichTextImages.length} richText images`);
    }
  } catch (err) {
    logger.error(`failed to dispatch message: ${String(err)}`);
    
    // 即使出错也要按分类策略清理文�?(Requirements 8.1, 8.2)
    // 图片/音频/视频立即删除，文�?压缩�?代码文件保留�?agent 工具访问
    if (downloadedMedia && extractedFileInfo) {
      const category = resolveFileCategory(downloadedMedia.contentType, extractedFileInfo.fileName);
      if (category === "image" || category === "audio" || category === "video") {
        await cleanupFile(downloadedMedia.path, logger);
        logger.debug(`cleaned up media file on error: ${downloadedMedia.path}`);
      } else {
        logger.debug(`retaining file for agent access on error: ${downloadedMedia.path} (category: ${category})`);
      }
    }
    
    // richText 图片始终清理
    for (const img of downloadedRichTextImages) {
      await cleanupFile(img.path, logger);
    }
  }
}
