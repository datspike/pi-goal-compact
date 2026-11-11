import type { Api, Model } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, getKeybindings, Input, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { say } from "../language.js";

/** Формат и нечёткий поиск автодополнения штатной команды /model. */
export function modelCompletions(models: readonly Model<Api>[], prefix: string) {
 const filtered = fuzzyFilter([...models], prefix, model => `${model.id} ${model.name} ${model.provider}`);
 return filtered.length ? filtered.map(model => ({ value: `${model.provider}/${model.id}`, label: model.id, description: model.provider })) : null;
}

/** Только однозначное точное имя выбирает модель без открытия пикера. */
export function exactModel(models: readonly Model<Api>[], query: string): Model<Api> | undefined {
 const lower = query.trim().toLowerCase();
 const qualified = models.filter(model => `${model.provider}/${model.id}`.toLowerCase() === lower);
 if (qualified.length === 1) return qualified[0];
 const bare = models.filter(model => model.id.toLowerCase() === lower);
 return bare.length === 1 ? bare[0] : undefined;
}

/** Поиск и навигация на общих компонентах Pi без доступа к его внутреннему runtime. */
export class ModelChoice extends Container {
 readonly capturesViewportInput = true;
 private readonly input = new Input();
 private readonly listBox = new Container();
 private list!: SelectList;
 get focused(): boolean { return this.input.focused; }
 set focused(value: boolean) { this.input.focused = value; }
 constructor(private models: readonly Model<Api>[], private readonly theme: Theme, private readonly done: (model: Model<Api> | undefined) => void, query = "", current?: Model<Api>) {
  super();
  this.addChild(new DynamicBorder());
  this.addChild(new Spacer(1));
  this.addChild(new Text(say("Выбор следующей модели", "Choose the next model"), 0, 0));
  this.input.setValue(query);
  this.addChild(this.input);
  this.addChild(this.listBox);
  this.addChild(new Spacer(1));
  this.addChild(new Text(say("↑↓ выбрать · Enter подтвердить · Esc отменить", "↑↓ navigate · Enter select · Esc cancel"), 0, 0));
  this.addChild(new DynamicBorder());
  this.filter();
  if (!query && current) this.list.setSelectedIndex(models.findIndex(model => model.provider === current.provider && model.id === current.id));
 }
 private filter(): void {
  const items = modelCompletions(this.models, this.input.getValue()) ?? [];
  this.list = new SelectList(items, 10, {
   selectedPrefix: text => this.theme.fg("accent", text), selectedText: text => this.theme.fg("accent", text),
   description: text => this.theme.fg("muted", text), scrollInfo: text => this.theme.fg("dim", text), noMatch: text => this.theme.fg("warning", text),
  });
  this.list.onSelect = item => this.done(this.models.find(model => `${model.provider}/${model.id}` === item.value));
  this.list.onCancel = () => this.done(undefined);
  this.listBox.clear();
  this.listBox.addChild(this.list);
 }
 handleInput(data: string): void {
  const kb = getKeybindings();
  const navigation = ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel"] as const;
  if (navigation.some(key => kb.matches(data, key))) this.list.handleInput(data);
  else { this.input.handleInput(data); this.filter(); }
 }
}

/** Реестр и scoped models принадлежат Pi; команды не создают своих настроек моделей. */
export async function chooseModel(ctx: ExtensionContext, query: string): Promise<Model<Api> | undefined> {
 const models = ctx.scopedModels.length ? ctx.scopedModels.map(item => item.model) : ctx.modelRegistry.getAvailable();
 const exact = query && exactModel(models, query);
 if (exact) return exact;
 if (ctx.mode !== "tui") return undefined;
 return ctx.ui.custom<Model<Api> | undefined>((_tui, theme, _keys, done) => new ModelChoice(models, theme, done, query, ctx.model));
}
