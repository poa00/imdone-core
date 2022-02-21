const Emitter = require('events')
const Plugin = require('imdone-api')
const fs = require('fs')
const _path = require('path')
const downloadRepo = require('./adapters/git-download')
const rimraf = require('rimraf')
const sane = require('sane')
const debounce = require('lodash.debounce')

module.exports = class PluginManager extends Emitter {
  constructor(project) {
    super()
    this.project = project
    this.defaultPlugins = ['./epic-plugin', './extension-plugin']
    this.pluginsMap = {}
    this.pluginPath = _path.join(project.path, '.imdone', 'plugins')
    this.onDevChange = debounce(this.onDevChange.bind(this), 1000)
    this.loadPlugins()
  }

  async startDevMode() {
    if (this.project.config.devMode && !this.watcher) {
      if (!(await this.exists(this.pluginPath)))
        await fs.promises.mkdir(this.pluginPath)
      this.watcher = sane(this.pluginPath, {
        ignored(path) {
          return /node_modules/.test(path)
        },
      })
      this.watcher.on('change', (path, root, stat) => {
        this.onDevChange()
      })
      this.watcher.on('add', (path, root, stat) => {
        this.onDevChange()
      })
    }
  }

  stopDevMode() {
    this.watcher && this.watcher.close()
    this.watcher = null
  }

  initDevMode() {
    if (!this.project.config.devMode) this.stopDevMode()
    this.startDevMode()
  }

  onDevChange() {
    this.destroyPlugins()
    this.loadPlugins()
      .catch((err) => {
        console.error('Error reloading plugins.', err)
        this.emit('plugins-reloaded')
      })
      .then(() => {
        this.startDevMode()
        this.emit('plugins-reloaded')
      })
  }

  async uninstallPlugin(pluginName) {
    return new Promise((resolve, reject) => {
      console.log('Preparing to uninstall plugin:', pluginName)
      const pluginClassName = Object.keys(this.pluginsMap).find((key) => {
        return this.getPlugin(key).info.name === pluginName
      })
      if (!pluginClassName) {
        return reject(new Error('Unable to find plugin:' + pluginName))
      }
      const { info } = this.getPlugin(pluginClassName)
      const { path, version, name } = info
      const pkg = { version, name }
      console.log('Uninstalling:', pkg)

      rimraf(path, (err) => {
        if (err) return reject(err)
        delete this.pluginsMap[pluginClassName]
        this.emit('plugin-uninstalled', pluginName)
        resolve()
      })
    })
  }

  async installPlugin({ name, version }) {
    if (!(await this.exists(this.pluginPath)))
      await fs.promises.mkdir(this.pluginPath)
    const installPath = _path.join(this.pluginPath, name)
    await downloadRepo(version, installPath)
    console.log(`Done installing ${name}`)
    this.loadPlugin(installPath)
    this.emit('plugin-installed', name)
  }

  async loadPlugins() {
    return new Promise((resolve, reject) => {
      this.defaultPlugins.forEach((pluginPath) => this.loadPlugin(pluginPath))

      this.exists(this.pluginPath).then((path) => {
        if (!path) return resolve()
        fs.readdir(this.pluginPath, { withFileTypes: true }, (err, paths) => {
          if (err) return reject(err)
          paths
            .filter(
              (entry) =>
                entry.name !== 'node_modules' &&
                (entry.isDirectory() || entry.isSymbolicLink())
            )
            .map((entry) => _path.join(this.pluginPath, entry.name))
            .forEach((path) => {
              this.loadPlugin(path)
            })
          resolve()
        })
      })
    })
  }

  loadPlugin(path) {
    console.log('Loading plugin: ', path)
    try {
      // eslint-disable-next-line
      delete require.cache[require.resolve(path)]
      // eslint-disable-next-line
      const pluginClass = require(path)
      this.createPlugin(pluginClass, path)
    } catch (e) {
      console.error(`Error loading plugin at: ${path}`, e)
    }
  }

  createPlugin(pluginClass, path) {
    if (!this.isPlugin(pluginClass))
      throw new Error(`${pluginClass.name} is not a plugin`)
    const pluginInstance = new pluginClass(this.project)
    let info = { name: path }
    try {
      info = require(`${path}/package.json`)
      pluginInstance.getSettings = () => {
        return this.getPluginSettings(info.name)
      }
      info.path = path
      delete info.dependencies
      delete info.devDependencies
      delete info.scripts
      delete info.main
    } catch (e) {
      console.info('No info on plugin:', path)
    }
    this.pluginsMap[pluginClass.name.toString()] = {
      pluginInstance,
      pluginClass,
      info,
    }
  }

  destroyPlugins() {
    this.stopDevMode()
    this.eachPlugin(({ pluginInstance }) => {
      try {
        pluginInstance.destroy()
      } catch (e) {
        this.pluginError('destroy', pluginInstance, e)
      }
    })
  }

  isPlugin(pluginClass) {
    return Object.getPrototypeOf(pluginClass).name === Plugin.name
  }

  eachPlugin(cb) {
    Object.keys(this.pluginsMap).forEach((key) => {
      cb(this.getPlugin(key))
    })
  }

  getPlugins() {
    return Object.keys(this.pluginsMap).map((key) => {
      const { info, pluginInstance } = this.getPlugin(key)
      const schema = pluginInstance.getSettingsSchema()
      if (schema) {
        schema.id = info.name
        schema.title = `${info.name} settings`
      }
      return { ...info, schema }
    })
  }

  getPluginName(pluginInstance) {
    return Object.keys(this.pluginsMap).find(
      (pluginName) =>
        this.getPlugin(pluginName).pluginInstance === pluginInstance
    )
  }

  getPluginInstance(name) {
    return this.getPlugin(name).pluginInstance
  }

  getPlugin(name) {
    return this.pluginsMap[name]
  }

  getPluginSettings(name) {
    return this.project.config.plugins[name] || {}
  }

  pluginError(method, plugin, error) {
    console.error(
      `Plugin: ${this.getPluginName(plugin)} threw an error on ${method}: `,
      error
    )
  }

  onBoardUpdate(lists) {
    if (!lists || lists.length == 0) return
    this.eachPlugin(({ pluginInstance }) => {
      // const timeLabel = `${this.getPluginName(pluginInstance)} onBoardUpdate time`
      // console.time(timeLabel)
      try {
        pluginInstance.onBoardUpdate(lists)
      } catch (e) {
        this.pluginError('onBoardUpdate', pluginInstance, e)
      }
      // console.timeEnd(timeLabel)
    })
    return lists
  }

  onBeforeBoardUpdate() {
    this.eachPlugin(({ pluginInstance }) => {
      try {
        pluginInstance.onBeforeBoardUpdate()
      } catch (e) {
        this.pluginError('onBeforeBoardUpdate', pluginInstance, e)
      }
    })
  }

  onTaskUpdate(task) {
    this.eachPlugin(({ pluginInstance }) => {
      try {
        pluginInstance.onTaskUpdate(task)
      } catch (e) {
        this.pluginError('onTaskUpdate', pluginInstance, e)
      }
    })
  }

  getCardProperties(props) {
    let cardProps = {}
    this.eachPlugin(({ pluginInstance }) => {
      try {
        cardProps = { ...cardProps, ...pluginInstance.getCardProperties(props) }
      } catch (e) {
        this.pluginError('getCardProperties', pluginInstance, e)
      }
    })
    return cardProps
  }

  getCardActions(task) {
    let cardLinks = []
    this.eachPlugin(({ pluginInstance }) => {
      try {
        cardLinks = [
          ...cardLinks,
          ...pluginInstance.getCardActions(task).map((link, index) => {
            return {
              ...link,
              action: { plugin: this.getPluginName(pluginInstance), index },
            }
          }),
        ]
      } catch (e) {
        this.pluginError('getCardActions', pluginInstance, e)
      }
    })
    return cardLinks
  }

  getBoardActions() {
    let actions = []
    this.eachPlugin(({ pluginInstance }) => {
      try {
        actions = [
          ...actions,
          ...pluginInstance.getBoardActions().map((item, index) => {
            return {
              ...item,
              plugin: this.getPluginName(pluginInstance),
              index,
            }
          }),
        ]
      } catch (e) {
        this.pluginError('getBoardActions', plugin, e)
      }
    })
    return actions
  }

  async exists(path) {
    try {
      await fs.promises.access(path)
      return path
    } catch {
      return false
    }
  }

  performCardAction(action, task) {
    const plugin = this.getPluginInstance(action.plugin)
    try {
      plugin.getCardActions(task)[action.index].action()
    } catch (e) {
      this.pluginError('getCardActions', plugin, e)
    }
  }

  performBoardAction(action) {
    const plugin = this.getPluginInstance(action.plugin)
    try {
      plugin.getBoardActions()[action.index].action()
    } catch (e) {
      this.pluginError('getBoardActions', plugin, e)
    }
  }
}