import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  EmbeddedTerminalRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import {
  defaultTerminalEnvironment,
  recordJourney,
  renderRecordedJourney,
  journeyFrames,
  renderReplayFrame,
  journeyStories,
  STATUS_FRAME_MS,
  CLEAR_STATUS_LINE,
  renderStatusLine,
  type RecordedJourney,
} from "../../cli/src/front-end";
import { stripVTControlCharacters } from "node:util";
import { JourneyPlayback } from "./playback";
import { catalog, filterCatalog, renderOutput, type CatalogItem } from "./model";

export function mountStorybook(renderer: CliRenderer, options: { animate?: boolean } = {}) {
  const colors = {
    canvas: "#09090b",
    panel: "#18181b",
    border: "#3f3f46",
    accent: "#38bdf8",
    text: "#e4e4e7",
    muted: "#71717a",
    selected: "#0ea5e9",
  };

  let items: ReadonlyArray<CatalogItem> = catalog;
  let selected = 0;
  let format: "human" | "json" = "human";
  let detail: "summary" | "full" = "summary";
  let query = "";
  let current: BoxRenderable | undefined;
  let generation = 0;
  let list: SelectRenderable;
  let previewBox: BoxRenderable;
  let previewText: TextRenderable;
  let previewScroll: ScrollBoxRenderable;
  let previewTerminal: EmbeddedTerminalRenderable;
  let footer: TextRenderable;
  let search: InputRenderable;
  let focus: "catalog" | "preview" = "catalog";
  let transcript = false;
  let playback: JourneyPlayback | undefined;
  let recorded: RecordedJourney | undefined;
  let terminalPrefix: string | undefined;
  let previewTask: Promise<void> = Promise.resolve();
  const recordings = new Map<number, Promise<RecordedJourney>>();

  const environment = () => ({
    ...defaultTerminalEnvironment,
    format,
    detail,
    color: true,
  });

  const text = (id: string, content: string, options = {}) =>
    new TextRenderable(renderer, { id, content, fg: colors.text, ...options });

  function selectedItem(): CatalogItem | undefined {
    return items[selected];
  }

  function draw(): void {
    if (current) {
      renderer.root.remove(current);
      current.destroyRecursively();
    }
    const root = new BoxRenderable(renderer, {
      id: "storybook",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: colors.canvas,
    });
    root.add(
      text(
        "header",
        ` SKIT OUTPUTS · SLOP DEVTOOL   ${items.length} stories   ${format.toUpperCase()} / ${detail.toUpperCase()}`,
        { height: 2, fg: colors.accent },
      ),
    );
    search = new InputRenderable(renderer, {
      id: "search",
      width: "100%",
      placeholder: "Search outputs and journeys…",
      value: query,
      textColor: colors.text,
      cursorColor: colors.accent,
      backgroundColor: colors.panel,
    });
    search.on(InputRenderableEvents.INPUT, (value: string) => {
      query = value;
      items = filterCatalog(value);
      selected = 0;
      draw();
    });
    root.add(search);
    const body = new BoxRenderable(renderer, {
      id: "body",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
      padding: 1,
    });
    const sidebar = new BoxRenderable(renderer, {
      id: "catalog",
      width: 43,
      height: "100%",
      border: true,
      borderColor: colors.border,
      title: " CATALOG ",
    });
    list = new SelectRenderable(renderer, {
      id: "stories",
      width: "100%",
      height: "100%",
      selectedIndex: selected,
      options: items.map((item) => ({
        name: item.key,
        description: item.kind === "output" ? "COMMAND OUTPUT" : "INTERACTIVE JOURNEY",
        value: item.key,
      })),
      textColor: colors.text,
      descriptionColor: colors.muted,
      selectedBackgroundColor: colors.selected,
      selectedTextColor: colors.canvas,
      selectedDescriptionColor: colors.canvas,
      showScrollIndicator: true,
      wrapSelection: true,
    });
    list.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
      selected = index;
      playback = undefined;
      requestPreview();
    });
    sidebar.onMouseScroll = (event) => {
      const steps = Math.max(1, Math.round(Math.abs(event.scroll?.delta ?? 1)));
      if (event.scroll?.direction === "up") list.moveUp(steps);
      if (event.scroll?.direction === "down") list.moveDown(steps);
      event.preventDefault();
      event.stopPropagation();
    };
    sidebar.add(list);
    previewBox = new BoxRenderable(renderer, {
      id: "preview",
      flexGrow: 1,
      minWidth: 0,
      height: "100%",
      border: true,
      borderColor: colors.accent,
      title: ` PREVIEW · ${selectedItem()?.key ?? "NO MATCH"} `,
      padding: 1,
    });
    previewScroll = new ScrollBoxRenderable(renderer, {
      id: "preview-scroll",
      width: "100%",
      height: "100%",
      verticalScrollbarOptions: { visible: true },
    });
    previewText = text("preview-text", "");
    previewScroll.add(previewText);
    previewBox.add(previewScroll);
    previewTerminal = new EmbeddedTerminalRenderable(renderer, {
      id: "preview-terminal",
      width: "100%",
      height: "100%",
      maxScrollback: 2000,
      visible: false,
    });
    previewBox.add(previewTerminal);
    body.add(sidebar);
    body.add(previewBox);
    root.add(body);
    footer = text("footer", "", { height: 3, fg: colors.muted });
    root.add(footer);
    current = root;
    renderer.root.add(root);
    if (focus === "catalog") search.focus();
    requestPreview();
  }

  function replacePreviewText(content: string): void {
    previewScroll.remove(previewText);
    previewText.destroyRecursively();
    previewText = text("preview-text", content);
    previewScroll.add(previewText);
  }

  async function updatePreview(content: string, token: number): Promise<void> {
    previewBox.title = ` PREVIEW · ${selectedItem()?.key ?? "NO MATCH"} `;
    replacePreviewText("");
    previewScroll.scrollTo(0);
    renderer.requestRender();
    await renderer.idle();
    if (token !== generation) return;
    if (selectedItem()?.kind === "output" && format === "human") {
      previewScroll.visible = false;
      previewTerminal.visible = true;
      previewTerminal.write("\u001b[2J\u001b[H\u001b[?25l" + content.replace(/\r?\n/g, "\r\n"));
    } else replacePreviewText(content);
    renderer.requestRender();
  }

  function updateChrome(): void {
    const step = playback ? ` · ${playback.index + 1}/${playback.frames.length}` : "";
    previewBox.title = ` ${transcript ? "TRANSCRIPT" : "PREVIEW"}${step} `;
    footer.content =
      focus === "catalog"
        ? " ↑↓/wheel browse · type search · tab preview · ctrl+f format · ctrl+d detail · esc clear · ctrl+c quit"
        : !playback
          ? " tab search · ctrl+f format · ctrl+d detail · ↑↓ scroll JSON"
          : ` ← prev · →/enter next · space ${playback?.playing ? "pause" : "play"} · home restart · t ${transcript ? "preview" : "transcript"} · tab search\n ${playback?.frame?.label ?? selectedItem()?.key ?? ""} · ${recorded?.initialState ?? ""}${playback && playback.index === playback.frames.length - 1 ? ` · ${recorded?.finalState ?? ""}` : ""}`;
    previewBox.borderColor = focus === "preview" ? colors.accent : colors.border;
  }

  function showReplay(): void {
    if (!playback || !recorded) return;
    previewScroll.visible = transcript || format === "json";
    previewTerminal.visible = !previewScroll.visible;
    if (transcript) {
      terminalPrefix = undefined;
      replacePreviewText(
        stripVTControlCharacters(
          renderRecordedJourney(recorded, { ...environment(), color: false }, process.cwd()),
        ),
      );
    } else if (format === "json") {
      terminalPrefix = undefined;
      replacePreviewText(playback.frame?.output ?? "");
    } else {
      const frame = playback.frame;
      const prefix = frame ? frame.output + (frame.prompt ? `${frame.prompt}\n` : "") : "";
      if (frame?.status && terminalPrefix === prefix) {
        previewTerminal.write(
          CLEAR_STATUS_LINE + renderStatusLine(frame.status, playback.spinnerFrame, true),
        );
      } else {
        previewTerminal.write(
          "\u001b[2J\u001b[H\u001b[?25l" +
            (frame
              ? renderReplayFrame(frame, playback.spinnerFrame, true).replace(/\r?\n/g, "\r\n")
              : ""),
        );
      }
      terminalPrefix = frame?.status ? prefix : undefined;
    }
    updateChrome();
    renderer.requestRender();
  }

  async function refreshPreview(): Promise<void> {
    const item = selectedItem();
    const token = ++generation;
    const previousIndex = playback?.index ?? 0;
    playback = undefined;
    recorded = undefined;
    terminalPrefix = undefined;
    previewScroll.visible = true;
    previewTerminal.visible = false;
    updateChrome();
    if (!item) return updatePreview("No matching stories", token);
    if (item.kind === "output")
      return updatePreview(renderOutput(item.index, environment()), token);
    await updatePreview("Preparing isolated journey fixture…", token);
    if (token !== generation) return;
    let recording = recordings.get(item.index);
    if (!recording) {
      const story = journeyStories[item.index];
      if (!story) return;
      recording = Effect.runPromise(recordJourney(story).pipe(Effect.provide(NodeServices.layer)));
      recordings.set(item.index, recording);
    }
    const journey = await recording;
    if (token !== generation) return;
    recorded = journey;
    playback = new JourneyPlayback(journeyFrames(journey, environment()));
    playback.seek(previousIndex);
    showReplay();
  }

  function requestPreview(): void {
    const token = generation + 1;
    previewTask = refreshPreview().catch((error: unknown) => {
      if (token !== generation) return;
      replacePreviewText(`Could not prepare journey: ${String(error)}`);
      renderer.requestRender();
    });
  }

  function tick(milliseconds = STATUS_FRAME_MS): void {
    if (!playback) return;
    const previous = playback.index;
    playback.tick(milliseconds);
    if (previous !== playback.index || (!transcript && playback.frame?.status)) showReplay();
  }

  function handleKey(key: KeyEvent): void {
    if (key.ctrl && key.name === "c") return renderer.destroy();
    if (key.name === "tab") {
      key.preventDefault();
      focus = focus === "catalog" ? "preview" : "catalog";
      if (focus === "catalog") search.focus();
      else search.blur();
      updateChrome();
      return;
    }
    if (key.ctrl && key.name === "f") {
      key.preventDefault();
      format = format === "human" ? "json" : "human";
      requestPreview();
    } else if (key.ctrl && key.name === "d") {
      key.preventDefault();
      detail = detail === "summary" ? "full" : "summary";
      requestPreview();
    } else if (focus === "preview") {
      key.preventDefault();
      if (previewScroll.visible && key.name === "up") {
        previewScroll.scrollBy(-3);
        return;
      }
      if (previewScroll.visible && key.name === "down") {
        previewScroll.scrollBy(3);
        return;
      }
      if (key.name === "t" && playback) {
        if (playback) playback.playing = false;
        transcript = !transcript;
        showReplay();
      } else if (playback) {
        if (key.name === "right" || key.name === "return" || key.name === "enter")
          playback.seek(playback.index + 1);
        else if (key.name === "left") playback.seek(playback.index - 1);
        else if (key.name === "home") playback.seek(0);
        else if (key.name === "space") playback.toggle();

        showReplay();
      }
    } else if (key.name === "up") {
      key.preventDefault();
      list.moveUp();
    } else if (key.name === "down") {
      key.preventDefault();
      list.moveDown();
    } else if (key.name === "escape") {
      key.preventDefault();
      query = "";
      items = catalog;
      selected = 0;
      draw();
    }
  }

  renderer.keyInput.on("keypress", handleKey);
  const timer = options.animate === false ? undefined : setInterval(() => tick(), STATUS_FRAME_MS);
  renderer.on("destroy", () => {
    generation++;
    if (timer) clearInterval(timer);
    renderer.keyInput.off("keypress", handleKey);
  });
  draw();
  return {
    settled: () => previewTask,
    tick,
    state: () => ({
      key: selectedItem()?.key,
      focus,
      transcript,
      index: playback?.index,
      count: playback?.frames.length,
      playing: playback?.playing,
      status: playback?.frame?.status,
    }),
    screen: () => previewTerminal.screen(),
  };
}
