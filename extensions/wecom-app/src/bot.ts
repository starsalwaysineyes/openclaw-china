/**
 * 企业微信自建应用消息处理
 *
 * 按参考实现的 session/envelope + buffered dispatcher 方式分发
 * 支持主动发送消息
 */

import {
  checkDmPolicy,
  checkGroupPolicy,
  createLogger,
  type Logger,
} from "@openclaw-china/shared";

import type { PluginRuntime } from "./runtime.js";
import type { ResolvedWecomAppAccount, WecomAppInboundMessage, WecomAppDmPolicy } from "./types.js";
import {
  resolveAllowFrom,
  resolveGroupAllowFrom,
  resolveGroupPolicy,
  resolveRequireMention,
  type PluginConfig,
} from "./config.js";
import { sendWecomAppMessage } from "./api.js";

export type WecomAppDispatchHooks = {
  onChunk: (text: string) => void;
  onError?: (err: unknown) => void;
};

/**
 * 提取消息内容
 */
export function extractWecomAppContent(msg: WecomAppInboundMessage): string {
  const msgtype = String(msg.msgtype ?? msg.MsgType ?? "").toLowerCase();

  if (msgtype === "text") {
    const content = (msg as { text?: { content?: string }; Content?: string }).text?.content ?? (msg as { Content?: string }).Content;
    return typeof content === "string" ? content : "";
  }
  if (msgtype === "voice") {
    const content = (msg as { voice?: { content?: string }; Recognition?: string }).voice?.content ?? (msg as { Recognition?: string }).Recognition;
    return typeof content === "string" ? content : "[voice]";
  }
  if (msgtype === "mixed") {
    const items = (msg as { mixed?: { msg_item?: unknown } }).mixed?.msg_item;
    if (Array.isArray(items)) {
      return items
        .map((item: unknown) => {
          if (!item || typeof item !== "object") return "";
          const typed = item as { msgtype?: string; text?: { content?: string }; image?: { url?: string } };
          const t = String(typed.msgtype ?? "").toLowerCase();
          if (t === "text") return String(typed.text?.content ?? "");
          if (t === "image") return `[image] ${String(typed.image?.url ?? "").trim()}`.trim();
          return t ? `[${t}]` : "";
        })
        .filter((part) => Boolean(part && part.trim()))
        .join("\n");
    }
    return "[mixed]";
  }
  if (msgtype === "image") {
    const url = String((msg as { image?: { url?: string }; PicUrl?: string }).image?.url ?? (msg as { PicUrl?: string }).PicUrl ?? "").trim();
    return url ? `[image] ${url}` : "[image]";
  }
  if (msgtype === "file") {
    const url = String((msg as { file?: { url?: string } }).file?.url ?? "").trim();
    return url ? `[file] ${url}` : "[file]";
  }
  if (msgtype === "event") {
    const eventtype = String(
      (msg as { event?: { eventtype?: string }; Event?: string }).event?.eventtype ??
      (msg as { Event?: string }).Event ?? ""
    ).trim();
    return eventtype ? `[event] ${eventtype}` : "[event]";
  }
  if (msgtype === "stream") {
    const id = String((msg as { stream?: { id?: string } }).stream?.id ?? "").trim();
    return id ? `[stream_refresh] ${id}` : "[stream_refresh]";
  }
  return msgtype ? `[${msgtype}]` : "";
}

function resolveSenderId(msg: WecomAppInboundMessage): string {
  const userid = msg.from?.userid?.trim() ?? (msg as { FromUserName?: string }).FromUserName?.trim();
  return userid || "unknown";
}

function resolveChatType(msg: WecomAppInboundMessage): "direct" | "group" {
  return msg.chattype === "group" ? "group" : "direct";
}

function resolveChatId(msg: WecomAppInboundMessage, senderId: string, chatType: "direct" | "group"): string {
  if (chatType === "group") {
    return msg.chatid?.trim() || "unknown";
  }
  return senderId;
}

function buildInboundBody(msg: WecomAppInboundMessage): string {
  return extractWecomAppContent(msg);
}

/**
 * 分发企业微信自建应用消息
 */
export async function dispatchWecomAppMessage(params: {
  cfg?: PluginConfig;
  account: ResolvedWecomAppAccount;
  msg: WecomAppInboundMessage;
  core: PluginRuntime;
  hooks: WecomAppDispatchHooks;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}): Promise<void> {
  const { cfg, account, msg, core, hooks } = params;
  const safeCfg = (cfg ?? {}) as PluginConfig;

  const logger: Logger = createLogger("wecom-app", { log: params.log, error: params.error });

  const chatType = resolveChatType(msg);
  const senderId = resolveSenderId(msg);
  const chatId = resolveChatId(msg, senderId, chatType);

  const accountConfig = account?.config ?? {};

  if (chatType === "group") {
    const groupPolicy = resolveGroupPolicy(accountConfig);
    const groupAllowFrom = resolveGroupAllowFrom(accountConfig);
    const requireMention = resolveRequireMention(accountConfig);

    const policyResult = checkGroupPolicy({
      groupPolicy,
      conversationId: chatId,
      groupAllowFrom,
      requireMention,
      mentionedBot: true,
    });

    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  } else {
    const dmPolicyRaw: WecomAppDmPolicy = accountConfig.dmPolicy ?? "pairing";
    if (dmPolicyRaw === "disabled") {
      logger.debug("dmPolicy=disabled, skipping dispatch");
      return;
    }

    const allowFrom = resolveAllowFrom(accountConfig);
    const policyResult = checkDmPolicy({
      dmPolicy: dmPolicyRaw,
      senderId,
      allowFrom,
    });

    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  }

  const channel = core.channel;
  if (!channel?.routing?.resolveAgentRoute || !channel.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    logger.debug("core routing or buffered dispatcher missing, skipping dispatch");
    return;
  }

  const route = channel.routing.resolveAgentRoute({
    cfg: safeCfg,
    channel: "wecom-app",
    peer: { kind: chatType === "group" ? "group" : "dm", id: chatId },
  });

  const rawBody = buildInboundBody(msg);
  const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${senderId}`;

  const storePath = channel.session?.resolveStorePath?.(safeCfg.session?.store, {
    agentId: route.agentId,
  });

  const previousTimestamp = channel.session?.readSessionUpdatedAt
    ? channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      }) ?? undefined
    : undefined;

  const envelopeOptions = channel.reply?.resolveEnvelopeFormatOptions
    ? channel.reply.resolveEnvelopeFormatOptions(safeCfg)
    : undefined;

  const body = channel.reply?.formatAgentEnvelope
    ? channel.reply.formatAgentEnvelope({
        channel: "WeCom App",
        from: fromLabel,
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody,
      })
    : rawBody;

  const msgid = msg.msgid ?? msg.MsgId ?? undefined;

  const ctxPayload = (channel.reply?.finalizeInboundContext
    ? channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: chatType === "group" ? `wecom-app:group:${chatId}` : `wecom-app:${senderId}`,
        To: `wecom-app:${chatId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: chatType,
        ConversationLabel: fromLabel,
        SenderName: senderId,
        SenderId: senderId,
        Provider: "wecom-app",
        Surface: "wecom-app",
        MessageSid: msgid,
        OriginatingChannel: "wecom-app",
        OriginatingTo: `wecom-app:${chatId}`,
      })
    : {
        Body: body,
        RawBody: rawBody,
        CommandBody: rawBody,
        From: chatType === "group" ? `wecom-app:group:${chatId}` : `wecom-app:${senderId}`,
        To: `wecom-app:${chatId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: chatType,
        ConversationLabel: fromLabel,
        SenderName: senderId,
        SenderId: senderId,
        Provider: "wecom-app",
        Surface: "wecom-app",
        MessageSid: msgid,
        OriginatingChannel: "wecom-app",
        OriginatingTo: `wecom-app:${chatId}`,
      }) as {
    SessionKey?: string;
    [key: string]: unknown;
  };

  if (channel.session?.recordInboundSession && storePath) {
    await channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err: unknown) => {
        logger.error(`wecom-app: failed updating session meta: ${String(err)}`);
      },
    });
  }

  const tableMode = channel.text?.resolveMarkdownTableMode
    ? channel.text.resolveMarkdownTableMode({ cfg: safeCfg, channel: "wecom-app", accountId: account.accountId })
    : undefined;

  await channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: safeCfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }) => {
        const rawText = payload.text ?? "";
        if (!rawText.trim()) return;
        const converted = channel.text?.convertMarkdownTables && tableMode
          ? channel.text.convertMarkdownTables(rawText, tableMode)
          : rawText;
        hooks.onChunk(converted);
      },
      onError: (err: unknown, info: { kind: string }) => {
        hooks.onError?.(err);
        logger.error(`${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

/**
 * 主动发送消息 (仅限自建应用)
 */
export async function sendActiveMessage(params: {
  account: ResolvedWecomAppAccount;
  userId?: string;
  chatid?: string;
  message: string;
  log?: (msg: string) => void;
}): Promise<{ ok: boolean; error?: string; msgid?: string }> {
  const { account, userId, chatid, message } = params;

  if (!account.canSendActive) {
    return { ok: false, error: "Account not configured for active sending" };
  }

  try {
    const result = await sendWecomAppMessage(account, { userId, chatid }, message);
    return {
      ok: result.ok,
      error: result.ok ? undefined : result.errmsg,
      msgid: result.msgid,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
