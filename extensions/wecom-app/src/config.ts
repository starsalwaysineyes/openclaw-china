/**
 * 企业微信自建应用配置 schema
 */
import { z } from "zod";

import type {
  ResolvedWecomAppAccount,
  WecomAppAccountConfig,
  WecomAppConfig,
  WecomAppDmPolicy,
  WecomAppGroupPolicy,
} from "./types.js";

/** 默认账户 ID */
export const DEFAULT_ACCOUNT_ID = "default";

const WecomAppAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  webhookPath: z.string().optional(),
  token: z.string().optional(),
  encodingAESKey: z.string().optional(),
  receiveId: z.string().optional(),
  // 自建应用特有字段
  corpId: z.string().optional(),
  corpSecret: z.string().optional(),
  agentId: z.number().optional(),
  // 其他字段
  welcomeText: z.string().optional(),
  dmPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  requireMention: z.boolean().optional(),
});

export const WecomAppConfigSchema = WecomAppAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(WecomAppAccountSchema).optional(),
});

export type ParsedWecomAppConfig = z.infer<typeof WecomAppConfigSchema>;

export const WecomAppConfigJsonSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      enabled: { type: "boolean" },
      webhookPath: { type: "string" },
      token: { type: "string" },
      encodingAESKey: { type: "string" },
      receiveId: { type: "string" },
      corpId: { type: "string" },
      corpSecret: { type: "string" },
      agentId: { type: "number" },
      welcomeText: { type: "string" },
      dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist", "disabled"] },
      allowFrom: { type: "array", items: { type: "string" } },
      groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
      groupAllowFrom: { type: "array", items: { type: "string" } },
      requireMention: { type: "boolean" },
      defaultAccount: { type: "string" },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            enabled: { type: "boolean" },
            webhookPath: { type: "string" },
            token: { type: "string" },
            encodingAESKey: { type: "string" },
            receiveId: { type: "string" },
            corpId: { type: "string" },
            corpSecret: { type: "string" },
            agentId: { type: "number" },
            welcomeText: { type: "string" },
            dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist", "disabled"] },
            allowFrom: { type: "array", items: { type: "string" } },
            groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
            groupAllowFrom: { type: "array", items: { type: "string" } },
            requireMention: { type: "boolean" },
          },
        },
      },
    },
  },
};

export interface PluginConfig {
  session?: {
    store?: unknown;
  };
  channels?: {
    "wecom-app"?: WecomAppConfig;
  };
}

export function parseWecomAppConfig(raw: unknown): WecomAppConfig | undefined {
  const parsed = WecomAppConfigSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data as WecomAppConfig;
}

export function normalizeAccountId(raw?: string | null): string {
  const trimmed = String(raw ?? "").trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

function listConfiguredAccountIds(cfg: PluginConfig): string[] {
  const accounts = cfg.channels?.["wecom-app"]?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listWecomAppAccountIds(cfg: PluginConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultWecomAppAccountId(cfg: PluginConfig): string {
  const wecomAppConfig = cfg.channels?.["wecom-app"];
  if (wecomAppConfig?.defaultAccount?.trim()) return wecomAppConfig.defaultAccount.trim();
  const ids = listWecomAppAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: PluginConfig, accountId: string): WecomAppAccountConfig | undefined {
  const accounts = cfg.channels?.["wecom-app"]?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as WecomAppAccountConfig | undefined;
}

function mergeWecomAppAccountConfig(cfg: PluginConfig, accountId: string): WecomAppAccountConfig {
  const base = (cfg.channels?.["wecom-app"] ?? {}) as WecomAppConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...baseConfig } = base;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...baseConfig, ...account };
}

export function resolveWecomAppAccount(params: { cfg: PluginConfig; accountId?: string | null }): ResolvedWecomAppAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.["wecom-app"]?.enabled !== false;
  const merged = mergeWecomAppAccountConfig(params.cfg, accountId);
  const enabled = baseEnabled && merged.enabled !== false;

  const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;

  // 回调配置
  const token = merged.token?.trim() || (isDefaultAccount ? process.env.WECOM_APP_TOKEN?.trim() : undefined) || undefined;
  const encodingAESKey =
    merged.encodingAESKey?.trim() ||
    (isDefaultAccount ? process.env.WECOM_APP_ENCODING_AES_KEY?.trim() : undefined) ||
    undefined;
  const receiveId = merged.receiveId?.trim() ?? "";

  // 自建应用配置 (用于主动发送)
  const corpId = merged.corpId?.trim() || (isDefaultAccount ? process.env.WECOM_APP_CORP_ID?.trim() : undefined) || undefined;
  const corpSecret =
    merged.corpSecret?.trim() || (isDefaultAccount ? process.env.WECOM_APP_CORP_SECRET?.trim() : undefined) || undefined;
  const agentId =
    merged.agentId ?? (isDefaultAccount ? (process.env.WECOM_APP_AGENT_ID ? Number(process.env.WECOM_APP_AGENT_ID) : undefined) : undefined);

  const configured = Boolean(token && encodingAESKey);
  const canSendActive = Boolean(corpId && corpSecret && agentId);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    configured,
    token,
    encodingAESKey,
    receiveId,
    corpId,
    corpSecret,
    agentId,
    canSendActive,
    config: merged,
  };
}

export function listEnabledWecomAppAccounts(cfg: PluginConfig): ResolvedWecomAppAccount[] {
  return listWecomAppAccountIds(cfg)
    .map((accountId) => resolveWecomAppAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

export function resolveDmPolicy(config: WecomAppAccountConfig): WecomAppDmPolicy {
  return (config.dmPolicy ?? "pairing") as WecomAppDmPolicy;
}

export function resolveGroupPolicy(config: WecomAppAccountConfig): WecomAppGroupPolicy {
  return (config.groupPolicy ?? "open") as WecomAppGroupPolicy;
}

export function resolveRequireMention(config: WecomAppAccountConfig): boolean {
  if (typeof config.requireMention === "boolean") return config.requireMention;
  return true;
}

export function resolveAllowFrom(config: WecomAppAccountConfig): string[] {
  return config.allowFrom ?? [];
}

export function resolveGroupAllowFrom(config: WecomAppAccountConfig): string[] {
  return config.groupAllowFrom ?? [];
}
