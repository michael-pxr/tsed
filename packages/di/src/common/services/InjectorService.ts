import {
  ancestorsOf,
  catchError,
  classOf,
  deepClone,
  deepMerge,
  Hooks,
  isArray,
  isClass,
  isFunction,
  isInheritedFrom,
  isPromise,
  nameOf,
  Store
} from "@tsed/core";
import {filter} from "rxjs";
import {DI_PARAM_OPTIONS, INJECTABLE_PROP} from "../constants/constants.js";
import {Configuration} from "../decorators/configuration.js";
import {Injectable} from "../decorators/injectable.js";
import {Container} from "../domain/Container.js";
import {InjectablePropertyType} from "../domain/InjectablePropertyType.js";
import {LocalsContainer} from "../domain/LocalsContainer.js";
import {Provider} from "../domain/Provider.js";
import {ProviderScope} from "../domain/ProviderScope.js";
import {InjectionError} from "../errors/InjectionError.js";
import {UndefinedTokenError} from "../errors/UndefinedTokenError.js";
import type {DILogger} from "../interfaces/DILogger.js";
import {InjectableProperties, InjectablePropertyOptions, InjectablePropertyValue} from "../interfaces/InjectableProperties.js";
import type {InterceptorContext} from "../interfaces/InterceptorContext.js";
import type {InterceptorMethods} from "../interfaces/InterceptorMethods.js";
import type {InvokeOptions} from "../interfaces/InvokeOptions.js";
import type {ResolvedInvokeOptions} from "../interfaces/ResolvedInvokeOptions.js";
import type {TokenProvider} from "../interfaces/TokenProvider.js";
import {GlobalProviders} from "../registries/GlobalProviders.js";
import {createContainer} from "../utils/createContainer.js";
import {getConstructorDependencies} from "../utils/getConstructorDependencies.js";
import {resolveControllers} from "../utils/resolveControllers.js";
import {DIConfiguration} from "./DIConfiguration.js";

/**
 * This service contain all services collected by `@Service` or services declared manually with `InjectorService.factory()` or `InjectorService.service()`.
 *
 * ### Example:
 *
 * ```typescript
 * import {InjectorService} from "@tsed/di";
 *
 * // Import the services (all services are decorated with @Service()";
 * import MyService1 from "./services/service1.js";
 * import MyService2 from "./services/service2.js";
 * import MyService3 from "./services/service3.js";
 *
 * // When all services are imported, you can load InjectorService.
 * const injector = new InjectorService()
 *
 * await injector.load();
 *
 * const myService1 = injector.get<MyService1>(MyServcice1);
 * ```
 */
@Injectable({
  scope: ProviderScope.SINGLETON,
  global: true
})
export class InjectorService extends Container {
  public settings: DIConfiguration = new DIConfiguration();
  public logger: DILogger = console;
  private resolvedConfiguration: boolean = false;

  #cache = new LocalsContainer();
  #hooks = new Hooks();

  constructor() {
    super();
    this.#cache.set(InjectorService, this);
  }

  get resolvers() {
    return this.settings.resolvers!;
  }

  get scopes() {
    return this.settings.scopes || {};
  }

  /**
   * Retrieve default scope for a given provider.
   * @param provider
   */
  public scopeOf(provider: Provider) {
    return provider.scope || this.scopes[provider.type] || ProviderScope.SINGLETON;
  }

  /**
   * Return a list of instance build by the injector.
   */
  public toArray(): any[] {
    return [...this.#cache.values()];
  }

  /**
   * Get a service or factory already constructed from his symbol or class.
   *
   * #### Example
   *
   * ```typescript
   * import {InjectorService} from "@tsed/di";
   * import MyService from "./services.js";
   *
   * class OtherService {
   *      constructor(injectorService: InjectorService) {
   *          const myService = injectorService.get<MyService>(MyService);
   *      }
   * }
   * ```
   *
   * @param token The class or symbol registered in InjectorService.
   * @param options
   * @returns {boolean}
   */
  get<T = any>(token: TokenProvider<T>, options: any = {}): T | undefined {
    const instance = this.getInstance(token);

    if (instance !== undefined) {
      return instance;
    }

    if (!this.hasProvider(token)) {
      for (const resolver of this.resolvers) {
        const result = resolver.get(token, options);

        if (result !== undefined) {
          return result;
        }
      }
    }
  }

  /**
   * Return all instance of the same provider type
   * @param type
   * @param locals
   * @param options
   */
  getMany<Type = any>(type: any, locals?: LocalsContainer, options?: Partial<InvokeOptions<Type>>): Type[] {
    return this.getProviders(type).map((provider) => this.invoke(provider.token, locals, options)!);
  }

  /**
   * The has() method returns a boolean indicating whether an element with the specified key exists or not.
   * @returns {boolean}
   * @param token
   */
  has(token: TokenProvider): boolean {
    return this.#cache.get(token) !== undefined;
  }

  alias(token: TokenProvider, alias: TokenProvider) {
    this.#cache.set(alias, this.#cache.get(token));

    return this;
  }

  /**
   * Invoke the class and inject all services that required by the class constructor.
   *
   * #### Example
   *
   * ```typescript
   * import {InjectorService} from "@tsed/di";
   * import MyService from "./services.js";
   *
   * class OtherService {
   *     constructor(injectorService: InjectorService) {
   *          const myService = injectorService.invoke<MyService>(MyService);
   *      }
   *  }
   * ```
   *
   * @param token The injectable class to invoke. Class parameters are injected according constructor signature.
   * @param locals  Optional object. If preset then any argument Class are read from this object first, before the `InjectorService` is consulted.
   * @param options
   * @returns {T} The class constructed.
   */
  public invoke<T = any>(token: TokenProvider, locals?: LocalsContainer, options: Partial<InvokeOptions<T>> = {}): T {
    let instance: any = locals ? locals.get(token) : undefined;

    if (instance !== undefined) {
      return instance;
    }

    if (token === Configuration) {
      return this.settings as unknown as T;
    }

    instance = !options.rebuild ? this.getInstance(token) : undefined;

    if (instance != undefined) {
      return instance;
    }

    if (token === DI_PARAM_OPTIONS) {
      return {} as T;
    }

    const provider = this.ensureProvider(token);

    const set = (instance: any) => {
      this.#cache.set(token, instance);
      provider?.alias && this.alias(token, provider.alias);
    };

    if (!provider || options.rebuild) {
      instance = this.resolve(token, locals, options);

      if (this.hasProvider(token)) {
        set(instance);
      }

      return instance;
    }

    instance = this.resolve(token, locals, options);

    switch (this.scopeOf(provider)) {
      case ProviderScope.SINGLETON:
        if (provider.hooks && !options.rebuild) {
          this.registerHooks(provider, instance);
        }

        if (!provider.isAsync() || !isPromise(instance)) {
          set(instance);
          return instance;
        }

        // store promise to lock token in cache
        set(instance);

        instance = instance.then((instance: any) => {
          set(instance);

          return instance;
        });

        return instance;

      case ProviderScope.REQUEST:
        if (locals) {
          locals.set(token, instance);

          if (provider.hooks && provider.hooks.$onDestroy) {
            locals.hooks.on("$onDestroy", (...args: any[]) => provider.hooks!.$onDestroy(instance, ...args));
          }
        }

        return instance;
    }

    return instance;
  }

  /**
   * Build only providers which are asynchronous.
   */
  async loadAsync() {
    for (const [, provider] of this) {
      if (!this.has(provider.token) && provider.isAsync()) {
        await this.invoke(provider.token);
      }
    }
  }

  loadSync() {
    for (const [, provider] of this) {
      if (!this.has(provider.token) && this.scopeOf(provider) === ProviderScope.SINGLETON) {
        this.invoke(provider.token);
      }
    }
  }

  /**
   * Boostrap injector from container and resolve configuration.
   *
   * @param container
   */
  bootstrap(container: Container = createContainer()) {
    // Clone all providers in the container
    this.addProviders(container);

    // Resolve all configuration
    this.resolveConfiguration();

    // allow mocking or changing provider instance before loading injector
    this.resolveImportsProviders();

    return this;
  }

  /**
   * Load injector from a given module
   * @param rootModule
   */
  loadModule(rootModule: TokenProvider) {
    this.settings.routes = this.settings.routes.concat(resolveControllers(this.settings));

    const container = createContainer();
    container.delete(rootModule);

    container.addProvider(rootModule, {
      type: "server:module",
      scope: ProviderScope.SINGLETON
    });

    return this.load(container);
  }

  /**
   * Build all providers from given container (or GlobalProviders) and emit `$onInit` event.
   *
   * @param container
   */
  async load(container: Container = createContainer()) {
    this.bootstrap(container);

    // build async and sync provider
    await this.loadAsync();

    // load sync provider
    this.loadSync();

    await this.emit("$beforeInit");
    await this.emit("$onInit");
  }

  /**
   * Load all configurations registered on providers
   */
  resolveConfiguration() {
    if (this.resolvedConfiguration) {
      return;
    }
    const mergedConfiguration = new Map();

    super.forEach((provider) => {
      if (provider.configuration && provider.type !== "server:module") {
        Object.entries(provider.configuration).forEach(([key, value]) => {
          if (!["resolvers", "mount", "imports"].includes(key)) {
            value = mergedConfiguration.has(key) ? deepMerge(mergedConfiguration.get(key), value) : deepClone(value);
            mergedConfiguration.set(key, value);
          }
        });
      }

      if (provider.resolvers) {
        this.settings.resolvers = this.settings.resolvers.concat(provider.resolvers);
      }
    });

    mergedConfiguration.forEach((value, key) => {
      this.settings.set(key, deepMerge(value, this.settings.get(key)));
    });

    this.resolvedConfiguration = true;
  }

  /**
   *
   * @param instance
   * @param locals
   * @param options
   */
  public bindInjectableProperties(instance: any, locals: LocalsContainer, options: Partial<InvokeOptions>) {
    const properties: InjectableProperties = ancestorsOf(classOf(instance)).reduce((properties: any, target: any) => {
      const store = Store.from(target);

      return {
        ...properties,
        ...(store.get(INJECTABLE_PROP) || {})
      };
    }, {});

    Object.values(properties).forEach((definition) => {
      switch (definition.bindingType) {
        case InjectablePropertyType.PROPERTY:
          this.bindProperty(instance, definition, locals, options);
          break;
        case InjectablePropertyType.CONSTANT:
          this.bindConstant(instance, definition);
          break;
        case InjectablePropertyType.VALUE:
          this.bindValue(instance, definition);
          break;
        case InjectablePropertyType.INTERCEPTOR:
          this.bindInterceptor(instance, definition);
          break;
      }
    });
  }

  /**
   * Create an injectable property.
   *
   * @param instance
   * @param {string} propertyKey
   * @param {any} useType
   * @param resolver
   * @param options
   * @param locals
   * @param invokeOptions
   */
  public bindProperty(
    instance: any,
    {propertyKey, resolver, options = {}}: InjectablePropertyOptions,
    locals: LocalsContainer,
    invokeOptions: Partial<InvokeOptions>
  ) {
    let get: () => any;

    get = resolver(this, locals, {...invokeOptions, options});

    catchError(() =>
      Object.defineProperty(instance, propertyKey, {
        get
      })
    );
  }

  /**
   *
   * @param instance
   * @param {string} propertyKey
   * @param {any} useType
   */
  public bindValue(instance: any, {propertyKey, expression, defaultValue}: InjectablePropertyValue) {
    const descriptor = {
      get: () => this.settings.get(expression) || defaultValue,
      set: (value: any) => this.settings.set(expression, value),
      enumerable: true,
      configurable: true
    };

    catchError(() => Object.defineProperty(instance, propertyKey, descriptor));
  }

  /**
   *
   * @param instance
   * @param {string} propertyKey
   * @param {any} useType
   */
  public bindConstant(instance: any, {propertyKey, expression, defaultValue}: InjectablePropertyValue) {
    let bean: any;

    const get = () => {
      if (bean !== undefined) {
        return bean;
      }

      const value = this.settings.get(expression, defaultValue);
      bean = Object.freeze(deepClone(value));

      return bean;
    };

    const descriptor = {
      get,
      enumerable: true,
      configurable: true
    };

    catchError(() => Object.defineProperty(instance, propertyKey, descriptor));
  }

  /**
   *
   * @param instance
   * @param propertyKey
   * @param useType
   * @param options
   */
  public bindInterceptor(instance: any, {propertyKey, useType, options}: InjectablePropertyOptions) {
    const target = classOf(instance);
    const originalMethod = instance[propertyKey];

    instance[propertyKey] = (...args: any[]) => {
      const next = (err?: Error) => {
        if (!err) {
          return originalMethod.apply(instance, args);
        }

        throw err;
      };

      const context: InterceptorContext<any> = {
        target,
        propertyKey,
        args,
        options,
        next
      };

      const interceptor = this.get<InterceptorMethods>(useType)!;

      return interceptor.intercept!(
        {
          ...context,
          options
        },
        next
      );
    };
  }

  async lazyInvoke<T = any>(token: TokenProvider) {
    let instance = this.getInstance(token);

    if (!instance) {
      instance = await this.invoke<T>(token);

      if (isFunction(instance?.$onInit)) {
        await instance.$onInit();
      }
    }

    return instance;
  }

  /**
   * Emit an event to all service. See service [lifecycle hooks](/docs/services.md#lifecycle-hooks).
   * @param eventName The event name to emit at all services.
   * @param args List of the parameters to give to each service.
   * @returns {Promise<any[]>} A list of promises.
   */
  public emit(eventName: string, ...args: any[]) {
    return this.#hooks.asyncEmit(eventName, args);
  }

  /**
   * @param eventName
   * @param value
   * @param args
   */
  public alter<T = any>(eventName: string, value: any, ...args: any[]): T {
    return this.#hooks.alter(eventName, value, args);
  }

  /**
   * @param eventName
   * @param value
   * @param args
   */
  public alterAsync<T = any>(eventName: string, value: any, ...args: any[]): Promise<T> {
    return this.#hooks.asyncAlter(eventName, value, args);
  }

  destroy() {
    return this.emit("$onDestroy");
  }

  protected ensureProvider(token: TokenProvider, force: true): Provider;
  protected ensureProvider(token: TokenProvider, force: false): Provider | undefined;
  protected ensureProvider(token: TokenProvider): Provider | undefined;
  protected ensureProvider(token: TokenProvider, force = false): Provider | undefined {
    if (!this.hasProvider(token) && (GlobalProviders.has(token) || force)) {
      this.addProvider(token);
    }

    return this.getProvider(token)!;
  }

  protected getInstance(token: any) {
    return this.#cache.get(token);
  }

  /**
   * Invoke a class method and inject service.
   *
   * #### IInjectableMethod options
   *
   * * **target**: Optional. The class instance.
   * * **methodName**: `string` Optional. The method name.
   * * **designParamTypes**: `any[]` Optional. List of injectable types.
   * * **locals**: `Map<Function, any>` Optional. If preset then any argument Class are read from this object first, before the `InjectorService` is consulted.
   *
   * #### Example
   *
   * @param target
   * @param locals
   * @param options
   * @private
   */
  protected resolve<T>(
    target: TokenProvider,
    locals: LocalsContainer = new LocalsContainer(),
    options: Partial<InvokeOptions<T>> = {}
  ): T | Promise<T> {
    const resolvedOpts = this.mapInvokeOptions(target, locals, options);

    if (!resolvedOpts) {
      return undefined as T;
    }

    const {token, deps, construct, imports, provider} = resolvedOpts;

    if (provider) {
      GlobalProviders.onInvoke(provider, locals, {...resolvedOpts, injector: this});
    }

    let instance: any;
    let currentDependency: any = false;

    try {
      const invokeDependency =
        (parent?: any) =>
        (token: TokenProvider | [TokenProvider], index: number): any => {
          currentDependency = {token, index, deps};

          if (token !== DI_PARAM_OPTIONS) {
            const options = provider?.store?.get(`${DI_PARAM_OPTIONS}:${index}`);

            locals.set(DI_PARAM_OPTIONS, options || {});
          }

          if (isArray(token)) {
            return this.getMany(token[0], locals, options);
          }

          return isInheritedFrom(token, Provider, 1) ? provider : this.invoke(token, locals, {parent});
        };

      // Invoke manually imported providers
      imports.forEach(invokeDependency());

      // Inject dependencies
      const services = deps.map(invokeDependency(token));

      currentDependency = false;

      instance = construct(services);
    } catch (error) {
      InjectionError.throwInjectorError(token, currentDependency, error);
    }

    if (instance === undefined) {
      throw new InjectionError(
        token,
        `Unable to create new instance from undefined value. Check your provider declaration for ${nameOf(token)}`
      );
    }

    if (instance && isClass(classOf(instance))) {
      this.bindInjectableProperties(instance, locals, options);
    }

    return instance;
  }

  private resolveImportsProviders() {
    this.settings.imports = this.settings.imports
      ?.filter((meta) => meta.token !== InjectorService)
      .map((meta) => {
        if ("token" in meta) {
          const {token, ...props} = meta;

          const provider = this.ensureProvider(token, true);

          if (provider) {
            provider.useValue = undefined;
            provider.useAsyncFactory = undefined;
            provider.useFactory = undefined;

            if ("useClass" in props) {
              provider.useClass = props.useClass;
              return;
            }

            if ("useFactory" in props) {
              provider.useFactory = props.useFactory;
              return;
            }

            if ("useAsyncFactory" in props) {
              provider.useAsyncFactory = props.useAsyncFactory;
              return;
            }

            if ("use" in props) {
              provider.useValue = props.use;
              return;
            }
          }
        }

        return meta;
      })
      .filter(Boolean);
  }

  /**
   * Create options to invoke a provider or class.
   * @param token
   * @param locals
   * @param options
   */
  private mapInvokeOptions(
    token: TokenProvider,
    locals: Map<TokenProvider, any>,
    options: Partial<InvokeOptions>
  ): ResolvedInvokeOptions | false {
    let imports: TokenProvider[] | undefined = options.imports;
    let deps: TokenProvider[] | undefined = options.deps;
    let scope = options.scope;
    let construct;

    if (!token || token === Object) {
      throw new UndefinedTokenError();
    }

    let provider: Provider;

    if (!this.hasProvider(token)) {
      provider = new Provider(token);

      this.resolvers.forEach((resolver) => {
        const result = resolver.get(token, locals.get(DI_PARAM_OPTIONS));

        if (result !== undefined) {
          provider.useFactory = () => result;
        }
      });
    } else {
      provider = this.getProvider(token)!;
    }

    scope = scope || this.scopeOf(provider);
    deps = deps || provider.deps;
    imports = imports || provider.imports;

    if (provider.useValue !== undefined) {
      construct = () => (isFunction(provider.useValue) ? provider.useValue() : provider.useValue);
    } else if (provider.useFactory) {
      construct = (deps: any[]) => provider.useFactory!(...deps);
    } else if (provider.useAsyncFactory) {
      construct = async (deps: any[]) => {
        deps = await Promise.all(deps);
        return provider.useAsyncFactory!(...deps);
      };
    } else if (provider.useClass) {
      // useClass
      deps = deps || getConstructorDependencies(provider.useClass);
      construct = (deps: TokenProvider[]) => new provider.useClass(...deps);
    } else {
      return false;
    }

    return {
      token,
      scope: scope || Store.from(token).get("scope") || ProviderScope.SINGLETON,
      deps: deps! || [],
      imports: imports || [],
      construct,
      provider
    };
  }

  private registerHooks(provider: Provider, instance: any) {
    if (provider.hooks) {
      Object.entries(provider.hooks).forEach(([event, cb]) => {
        const callback = (...args: any[]) => cb(this.get(provider.token) || instance, ...args);

        this.#hooks.on(event, callback);
      });
    }
  }
}
