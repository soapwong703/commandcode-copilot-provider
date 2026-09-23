import vscode from "vscode";
import { AuthManager } from "../auth";
import { t } from "../i18n";
import { logger } from "../logger";
import { getLiveCatalog, liveModelToDefinition } from "./catalog";
import { toChatInfo } from "./models";
import { prepareChatRequest } from "./request";
import { streamChatCompletion } from "./stream";
import { estimateTokenCount } from "./tokens";

const PROVIDER_VENDOR = "commandcode";

/**
 * Command Code Chat Provider — implements `vscode.LanguageModelChatProvider`
 * so Command Code Provider models appear directly in the Copilot Chat
 * model picker.
 */
export class CommandCodeChatProvider implements vscode.LanguageModelChatProvider {
  private readonly authManager: AuthManager;
  private readonly globalState: vscode.Memento;
  private readonly onDidChangeLanguageModelChatInformationEmitter =
    new vscode.EventEmitter<void>();
  private isActive = true;
  private modelById = new Map<
    string,
    ReturnType<typeof liveModelToDefinition>
  >();
  private refreshInProgress = false;

  readonly onDidChangeLanguageModelChatInformation =
    this.onDidChangeLanguageModelChatInformationEmitter.event;

  /**
   * Adaptive chars-per-token ratio, calibrated from real usage data via an
   * exponential moving average each time the API reports token counts.
   */
  private charsPerToken = 4.0;

  constructor(context: vscode.ExtensionContext) {
    this.authManager = new AuthManager(context);
    this.globalState = context.globalState;

    context.subscriptions.push(
      this.onDidChangeLanguageModelChatInformationEmitter,
      // Settings-based API key + base URL changes.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("commandcode-copilot.apiKey") ||
          e.affectsConfiguration("commandcode-copilot.baseUrl") ||
          e.affectsConfiguration("commandcode-copilot.modelBlacklist") ||
          e.affectsConfiguration("commandcode-copilot.modelDetailStyle") ||
          e.affectsConfiguration("commandcode-copilot.modelIdOverrides") ||
          e.affectsConfiguration("commandcode-copilot.maxContextTokens")
        ) {
          this.refreshModelPicker();
        }
      }),
      // Multi-window: SecretStorage changes don't fire onDidChangeConfiguration.
      context.secrets.onDidChange((e) => {
        if (e.key === "commandcode-copilot.apiKey") {
          this.refreshModelPicker();
        }
      }),
    );
  }

  // ---- Public commands ----

  async configureApiKey(): Promise<void> {
    const saved = await this.authManager.promptForApiKey();
    if (saved) {
      this.refreshModelPicker();
    }
  }

  async clearApiKey(): Promise<void> {
    await this.authManager.deleteApiKey();
    this.refreshModelPicker();
    vscode.window.showInformationMessage(t("auth.removed"));
  }

  async hasApiKey(): Promise<boolean> {
    return this.authManager.hasApiKey();
  }

  /**
   * Force Copilot Chat to re-query model information.
   *
   * @param forceCatalogSync When true (the "Command Code: Refresh Models"
   * command), the next picker load re-fetches the live catalog from the API.
   * Otherwise only persisted data is used — no network traffic.
   */
  refreshModelPicker(forceCatalogSync = false): void {
    if (!forceCatalogSync) {
      this.onDidChangeLanguageModelChatInformationEmitter.fire();
      return;
    }
    if (!this.refreshInProgress) {
      this.refreshInProgress = true;
      void vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t("models.refreshInProgress"),
          cancellable: false,
        },
        async () => {
          try {
            let succeeded = false;
            const models = await getLiveCatalog(
              this.globalState,
              undefined,
              true,
              (success) => {
                succeeded = success;
              },
            );
            this.onDidChangeLanguageModelChatInformationEmitter.fire();
            if (succeeded) {
              void vscode.window.showInformationMessage(
                t("models.refreshSucceeded", models.size),
              );
            } else {
              void vscode.window.showWarningMessage(
                t("models.refreshFailed", t("models.refreshUsingCached")),
              );
            }
          } catch (error) {
            logger.warn("Manual model catalog refresh failed", error);
            void vscode.window.showWarningMessage(
              t("models.refreshFailed", String(error)),
            );
          } finally {
            this.refreshInProgress = false;
          }
        },
      );
    }
  }

  async prepareForDeactivate(): Promise<void> {
    this.isActive = false;
    this.onDidChangeLanguageModelChatInformationEmitter.fire();

    // Trigger one final sync pull so the picker drops our entries immediately
    // instead of waiting for the host to invalidate its cache. With
    // `isActive = false` we return [], which makes Copilot Chat drop
    // Command Code models from the picker immediately on deactivate.
    try {
      await vscode.lm.selectChatModels({ vendor: PROVIDER_VENDOR });
    } catch (error) {
      logger.warn(
        "Failed to refresh Command Code models during deactivate",
        error,
      );
    }
  }

  // ---- LanguageModelChatProvider ----

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (!this.isActive) {
      return [];
    }

    const hasKey = await this.authManager.hasApiKey();
    const { getModelBlacklist } = await import("../config");
    const blacklist = new Set(getModelBlacklist());

    // Catalog and first-party docs are refreshed together at most every 24h.
    const liveCatalog = await getLiveCatalog(this.globalState, token);
    this.modelById.clear();
    return [...liveCatalog].flatMap(([id, info]) => {
      if (blacklist.has(id)) return [];
      const definition = liveModelToDefinition(id, info);
      this.modelById.set(id, definition);
      if (!info.supportedEndpoints.includes("/chat/completions")) {
        logger.warn(
          `Model ${id} does not advertise /chat/completions (supported: ${info.supportedEndpoints.join(", ") || "unknown"})`,
        );
      }
      return [toChatInfo(definition, hasKey, info.contextLength)];
    });
  }

  async provideLanguageModelChatResponse(
    modelInfo: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const modelDefinition = this.modelById.get(modelInfo.id);

    const prepared = await prepareChatRequest({
      authManager: this.authManager,
      modelInfo,
      modelDefinition,
      messages,
      options,
      token,
    });

    return streamChatCompletion({
      prepared,
      progress,
      token,
      getCharsPerToken: () => this.charsPerToken,
      setCharsPerToken: (charsPerToken) => {
        this.charsPerToken = charsPerToken;
      },
    });
  }

  async provideTokenCount(
    _modelInfo: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    return estimateTokenCount(text, this.charsPerToken);
  }
}

export { PROVIDER_VENDOR };
