import { Client } from "langsmith";

export interface LangSmithRunClient {
  createRun(input: {
    id: string;
    name: string;
    run_type: "chain";
    project_name: string;
    start_time: string;
    end_time: string;
    inputs: Record<string, never>;
    outputs: Record<string, never>;
    extra: Record<string, unknown>;
  }): Promise<void>;
  updateRun(runId: string, input: {
    end_time: string;
    outputs: Record<string, never>;
    extra: Record<string, unknown>;
  }): Promise<void>;
}

export function createLangSmithRunClient(options: {
  apiKey: string;
  apiUrl?: string;
  workspaceId?: string;
}): LangSmithRunClient {
  const client = new Client({
    apiKey: options.apiKey,
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
  });
  return {
    createRun: (input) => client.createRun(input),
    updateRun: (runId, input) => client.updateRun(runId, input),
  };
}
