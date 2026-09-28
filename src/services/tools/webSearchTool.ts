import type { ToolDefinition, ToolResult } from "./ToolRegistry";

const TIME_RANGES = ["day", "week", "month", "year"] as const;
type TimeRange = (typeof TIME_RANGES)[number];

/** web_search over the user's SearXNG instance; the main process makes the request. */
export function createWebSearchTool(baseUrl: string): ToolDefinition {
  return {
    name: "web_search",
    description:
      "Search the web for current information. Returns relevant web results with titles, URLs, and snippets, plus direct answers when the search engine has one.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        numResults: {
          type: "number",
          description: "Number of results to return, 1-10 (default 5)",
        },
        timeRange: {
          type: "string",
          enum: [...TIME_RANGES],
          description: "Only return results from the past day, week, month, or year",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = typeof args.query === "string" ? args.query : "";
      const numResults = typeof args.numResults === "number" ? args.numResults : 5;
      const timeRange = TIME_RANGES.includes(args.timeRange as TimeRange)
        ? (args.timeRange as TimeRange)
        : undefined;

      try {
        const response = await window.electronAPI.agentWebSearch!(query, numResults, {
          baseUrl,
          timeRange,
        });
        if (!response.success) throw new Error(response.error);

        const { answers, infobox } = response;
        const results = response.results ?? [];
        return {
          success: true,
          data: {
            results,
            ...(answers ? { answers } : {}),
            ...(infobox ? { infobox } : {}),
          },
          displayText: `Found ${results.length} web results for "${query}"`,
        };
      } catch (error) {
        return {
          success: false,
          data: null,
          displayText: `Web search failed: ${(error as Error).message}`,
        };
      }
    },
  };
}
