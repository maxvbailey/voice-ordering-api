/**
 * Voice Orchestrator
 *
 * Routes natural language voice commands to the appropriate MCP tools.
 * Uses keyword/intent matching (no external LLM dependency) for fast,
 * deterministic responses in voice assistant contexts.
 */

import { McpClientManager } from "./mcp-client.js";

export interface VoiceRequest {
  text: string;
  spoonity_session_key?: string;
  vendor_id?: string;
  latitude?: number;
  longitude?: number;
  basket_id?: string;
  /** Conversation state for multi-turn interactions */
  state?: string;
  state_data?: Record<string, unknown>;
}

export interface VoiceResponse {
  response: string;
  actions?: { type: string; [key: string]: unknown }[];
  state?: string;
  state_data?: Record<string, unknown>;
  data?: unknown;
}

type IntentHandler = (req: VoiceRequest, mcp: McpClientManager) => Promise<VoiceResponse>;

// Intent patterns — ordered by specificity
const INTENTS: { patterns: RegExp[]; handler: IntentHandler }[] = [
  // ── Rewards / Balance ─────────────────────────────────────────────
  {
    patterns: [
      /\b(reward|points?|balance|loyalty|tier)\b/i,
      /\b(how much|what.*(have|got))\b.*\b(balance|points?|wallet)\b/i,
    ],
    handler: handleRewards,
  },

  // ── Store finding ─────────────────────────────────────────────────
  {
    patterns: [
      /\b(find|nearest|closest|near\s*me|where|locate|store|location)\b/i,
      /\b(open|hours|close)\b.*\b(store|shop|location)\b/i,
    ],
    handler: handleFindStore,
  },

  // ── Order status ──────────────────────────────────────────────────
  {
    patterns: [
      /\b(status|track|where.*order|ready|check.*order)\b/i,
    ],
    handler: handleOrderStatus,
  },

  // ── Reorder ───────────────────────────────────────────────────────
  {
    patterns: [
      /\b(reorder|order.*again|usual|same.*again|last.*order)\b/i,
    ],
    handler: handleReorder,
  },

  // ── Menu browsing ─────────────────────────────────────────────────
  {
    patterns: [
      /\b(menu|what.*serve|what.*have|browse|show.*menu)\b/i,
    ],
    handler: handleMenu,
  },

  // ── Order something ───────────────────────────────────────────────
  {
    patterns: [
      /\b(order|get|want|like|give me|i'?ll have|can i have)\b/i,
    ],
    handler: handleOrder,
  },

  // ── Help ──────────────────────────────────────────────────────────
  {
    patterns: [
      /\b(help|what can|how do|commands?)\b/i,
    ],
    handler: handleHelp,
  },
];

// ── Intent Handlers ─────────────────────────────────────────────────────────

async function handleRewards(req: VoiceRequest, mcp: McpClientManager): Promise<VoiceResponse> {
  if (!req.spoonity_session_key) {
    return { response: "I need you to be logged in to check your rewards. Please sign in first." };
  }

  try {
    const [balanceResult, rewardsResult] = await Promise.all([
      mcp.callTool("spoonity", "get_balance", {}, {
        "X-Spoonity-Session-Key": req.spoonity_session_key,
        "X-Spoonity-Vendor-Id": req.vendor_id || "",
      }),
      mcp.callTool("spoonity", "get_rewards", {}, {
        "X-Spoonity-Session-Key": req.spoonity_session_key,
        "X-Spoonity-Vendor-Id": req.vendor_id || "",
      }),
    ]);

    const balance = parseToolResult(balanceResult);
    const rewards = parseToolResult(rewardsResult);

    const walletAmount = balance?.amount ?? balance?.data?.amount ?? "unknown";
    const availableRewards = rewards?.data?.filter?.((r: any) => r.available > 0) || [];
    const tierName = rewards?.tier?.current?.name || "Member";

    let response = `You have $${walletAmount} in your Quick Pay wallet. `;
    response += `You're at ${tierName} tier. `;

    if (availableRewards.length > 0) {
      response += `You have ${availableRewards.length} reward${availableRewards.length > 1 ? 's' : ''} ready to use: `;
      response += availableRewards.map((r: any) => r.name).join(", ") + ". ";
      response += "Would you like to use one with your next order?";
    } else {
      response += "Keep earning points to unlock rewards!";
    }

    return {
      response,
      data: { balance, rewards },
      actions: availableRewards.length > 0 ? [{ type: "use_rewards" }] : [],
    };
  } catch (err: any) {
    return { response: `Sorry, I couldn't check your rewards right now. ${err.message}` };
  }
}

async function handleFindStore(req: VoiceRequest, mcp: McpClientManager): Promise<VoiceResponse> {
  try {
    const args: Record<string, unknown> = {};
    if (req.latitude && req.longitude) {
      args.latitude = req.latitude;
      args.longitude = req.longitude;
    }

    const result = await mcp.callTool("spoonity", "get_stores", args, {
      "X-Spoonity-Session-Key": req.spoonity_session_key || "",
      "X-Spoonity-Vendor-Id": req.vendor_id || "",
    });

    const stores = parseToolResult(result);
    const storeList = Array.isArray(stores) ? stores : stores?.data || [];
    const openStores = storeList.filter((s: any) => s.is_open);

    if (openStores.length === 0) {
      return { response: "I couldn't find any open stores near you right now. Try again later!" };
    }

    const top3 = openStores.slice(0, 3);
    let response = `I found ${openStores.length} open store${openStores.length > 1 ? 's' : ''}. `;
    response += top3.map((s: any, i: number) =>
      `${i + 1}. ${s.name} — ${s.address?.streetAddress || s.address || ""}${s.distance ? `, ${s.distance}` : ""}`
    ).join(". ");
    response += ". Would you like to order from one of these?";

    return {
      response,
      data: { stores: top3 },
      actions: top3.map((s: any) => ({
        type: "select_store",
        store_id: s.id,
        store_name: s.name,
      })),
    };
  } catch (err: any) {
    return { response: `Sorry, I couldn't find stores right now. ${err.message}` };
  }
}

async function handleOrderStatus(req: VoiceRequest, mcp: McpClientManager): Promise<VoiceResponse> {
  if (!req.state_data?.checkout_id) {
    return {
      response: "I don't have an active order to check. Would you like to place a new order?",
      actions: [{ type: "new_order" }],
    };
  }

  try {
    const result = await mcp.callTool("deliverect", "get_order_status", {
      checkout_id: req.state_data.checkout_id,
    });

    const status = parseToolResult(result);
    return {
      response: `Your order status is: ${status?.status || "pending"}. ${getStatusDescription(status?.status)}`,
      data: status,
    };
  } catch (err: any) {
    return { response: `Sorry, I couldn't check your order status. ${err.message}` };
  }
}

async function handleReorder(req: VoiceRequest, mcp: McpClientManager): Promise<VoiceResponse> {
  if (!req.spoonity_session_key) {
    return { response: "I need you to be logged in to reorder. Please sign in first." };
  }

  try {
    const result = await mcp.callTool("spoonity", "get_transactions", { limit: 5 }, {
      "X-Spoonity-Session-Key": req.spoonity_session_key,
      "X-Spoonity-Vendor-Id": req.vendor_id || "",
    });

    const transactions = parseToolResult(result);
    const txList = Array.isArray(transactions) ? transactions : transactions?.data || [];

    if (txList.length === 0) {
      return { response: "I don't see any previous orders. Would you like to start a new one?" };
    }

    const lastTx = txList[0];
    return {
      response: `Your last order was at ${lastTx.store?.name || "a store"} on ${new Date(lastTx.date).toLocaleDateString()}. Would you like to order from there again?`,
      data: { lastTransaction: lastTx },
      actions: [{ type: "confirm_reorder", store_name: lastTx.store?.name }],
      state: "confirm_reorder",
      state_data: { transaction: lastTx },
    };
  } catch (err: any) {
    return { response: `Sorry, I couldn't find your order history. ${err.message}` };
  }
}

async function handleMenu(req: VoiceRequest, mcp: McpClientManager): Promise<VoiceResponse> {
  try {
    // First find stores
    const storeResult = await mcp.callTool("deliverect", "list_stores", {});
    const stores = parseToolResult(storeResult);
    const storeList = Array.isArray(stores) ? stores : stores?.items || [];
    const openStores = storeList.filter((s: any) => s.status === "open");

    if (openStores.length === 0) {
      return { response: "No stores are currently open. Try again later!" };
    }

    const store = openStores[0];
    const menuResult = await mcp.callTool("deliverect", "get_menus", { store_id: store.id });
    const menus = parseToolResult(menuResult);
    const menuList = Array.isArray(menus) ? menus : [menus];

    if (menuList.length === 0) {
      return { response: "I couldn't load the menu right now. Please try again." };
    }

    const categories = menuList[0]?.categories?.map?.((c: any) => c.name) || [];

    return {
      response: `Here's what's available at ${store.name}: ${categories.join(", ")}. What sounds good?`,
      data: { store, menu: menuList[0] },
      state: "browsing_menu",
      state_data: { store_id: store.id, menu_id: menuList[0]?.menuId },
    };
  } catch (err: any) {
    return { response: `Sorry, I couldn't load the menu. ${err.message}` };
  }
}

async function handleOrder(req: VoiceRequest, mcp: McpClientManager): Promise<VoiceResponse> {
  // Extract what they want to order from the text
  const itemMatch = req.text.match(/(?:order|get|want|like|have)\s+(?:a\s+)?(.+?)(?:\s+from|\s+at|\s*$)/i);
  const itemName = itemMatch?.[1]?.trim() || req.text;

  return {
    response: `I'd love to help you order "${itemName}". Let me find that on the menu. First, which store would you like to order from?`,
    state: "selecting_store",
    state_data: { requested_item: itemName },
    actions: [{ type: "find_stores" }],
  };
}

async function handleHelp(_req: VoiceRequest, _mcp: McpClientManager): Promise<VoiceResponse> {
  return {
    response: `Here's what I can do: Check your rewards and balance. Find nearby stores. Browse the menu. Place an order. Reorder your last order. Check your order status. Just tell me what you'd like!`,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export class VoiceOrchestrator {
  private mcp: McpClientManager;

  constructor(mcp: McpClientManager) {
    this.mcp = mcp;
  }

  async process(req: VoiceRequest): Promise<VoiceResponse> {
    const text = req.text.toLowerCase().trim();

    if (!text) {
      return { response: "I didn't catch that. Could you try again?" };
    }

    // Check each intent pattern
    for (const intent of INTENTS) {
      for (const pattern of intent.patterns) {
        if (pattern.test(text)) {
          try {
            return await intent.handler(req, this.mcp);
          } catch (err: any) {
            console.error(`[orchestrator] Intent handler error:`, err);
            return { response: `Sorry, something went wrong. Please try again.` };
          }
        }
      }
    }

    // Fallback
    return {
      response: `I'm not sure what you'd like. I can help you check rewards, find stores, browse menus, or place orders. What would you like?`,
      actions: [{ type: "show_help" }],
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseToolResult(result: any): any {
  try {
    const content = result?.content?.[0];
    if (content?.type === "text") {
      return JSON.parse(content.text);
    }
    return content;
  } catch {
    return result;
  }
}

function getStatusDescription(status?: string): string {
  switch (status) {
    case "pending": return "We're confirming your order with the store.";
    case "confirmed": return "The store has received your order and is getting started!";
    case "preparing": return "Your order is being prepared.";
    case "ready": return "Your order is ready for pickup!";
    case "completed": return "Your order has been completed. Enjoy!";
    case "failed": return "Unfortunately something went wrong. Please try ordering again.";
    default: return "";
  }
}
