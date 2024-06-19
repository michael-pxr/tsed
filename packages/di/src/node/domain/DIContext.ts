import {InjectorService, LocalsContainer} from "../../common/index.js";
import {runInContext} from "../utils/asyncHookContext.js";
import {ContextLogger, ContextLoggerOptions} from "./ContextLogger.js";

export interface DIContextOptions extends Omit<ContextLoggerOptions, "dateStart"> {
  id: string;
  injector: InjectorService;
  logger: any;
  platform?: string;
}

export class DIContext {
  [x: string]: any;
  readonly PLATFORM: string = "DI";
  #container?: LocalsContainer;
  #cache?: Map<any, any>;
  #logger?: ContextLogger;

  constructor(public opts: DIContextOptions) {
    this.PLATFORM = opts.platform || this.PLATFORM;
  }

  /**
   * Logger attached to the context request.
   */
  get logger() {
    this.#logger = this.#logger || new ContextLogger(this.opts);
    return this.#logger;
  }

  /**
   * Request id generated by @@contextMiddleware@@.
   *
   * ::: tip
   * By default Ts.ED generate uuid like that `uuidv4().replace(/-/gi, ""))`.
   * Dash are removed to simplify tracking logs in Kibana
   * :::
   *
   * ::: tip
   * Request id can by customized by changing the server configuration.
   *
   * ```typescript
   * @Configuration({
   *   logger: {
   *     reqIdBuilder: createUniqId // give your own id generator function
   *   }
   * })
   * class Server {
   *
   * }
   * ```
   * :::
   *
   */
  get id() {
    return this.opts.id;
  }

  get dateStart() {
    return this.logger.dateStart;
  }

  get injector(): InjectorService {
    return this.opts.injector!;
  }

  get env() {
    return this.injector.settings.get("env");
  }

  /**
   * The request container used by the Ts.ED DI. It contains all services annotated with `@Scope(ProviderScope.REQUEST)`
   */
  get container() {
    return (this.#container = this.#container || new LocalsContainer());
  }

  destroy(): Promise<any> {
    return Promise.all([this.#container?.destroy(), this.#logger?.flush(true)]);
  }

  emit(eventName: string, ...args: any[]) {
    return this.injector?.emit(eventName, ...args);
  }

  runInContext(next: Function) {
    return runInContext(this, next);
  }

  cache<Value = any>(key: string, cb: () => Value): Value {
    if (!this.has(key)) {
      this.set(key, cb());
    }

    return this.get(key);
  }

  async cacheAsync<Value = any>(key: string, cb: () => Promise<Value>): Promise<Value> {
    if (!this.has(key)) {
      this.set(key, await cb());
    }

    return this.get(key);
  }

  delete(key: any): boolean {
    return !!this.#cache?.delete(key);
  }

  get<T = any>(key: any): T {
    return this.#cache?.get(key);
  }

  has(key: any): boolean {
    return !!this.#cache?.has(key);
  }

  set(key: any, value: any): this {
    this.#cache = this.#cache || new Map<any, any>();
    this.#cache.set(key, value);
    return this;
  }
}

export type BaseContext = DIContext & TsED.Context;
