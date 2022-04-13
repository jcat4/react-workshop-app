import type {SetupWorkerApi} from 'msw'
import preval from 'preval.macro'
import React from 'react'
import {createRoot} from 'react-dom/client'
import {createBrowserHistory} from 'history'
import {setup as setupServer} from './server'
import {renderReactApp} from './react-app'
import type {
  FileInfo,
  LazyComponents,
  Imports,
  Backend,
  DynamicImportFn,
  DefaultDynamicImportFn,
} from './types'

const styleTag = document.createElement('style')
const requiredStyles = [
  preval`module.exports = require('../other/css-file-to-string')('normalize.css/normalize.css')`,
  preval`module.exports = require('../other/css-file-to-string')('./other/workshop-app-styles.css')`,
  // this will happen when running the regular app and embedding the example
  // in an iframe.
  // pretty sure the types are wrong on this one... (It's been fixed in TS 4.2)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  window.frameElement
    ? `#root{display:grid;place-items:center;height:100vh;}`
    : '',
].join('\n')
styleTag.appendChild(document.createTextNode(requiredStyles))
document.head.prepend(styleTag)

const fillScreenCenter = `padding:30px;min-height:100vh;display:grid;align-items:center;justify-content:center;`

const originalDocumentElement = document.documentElement

let unmount: ((el: HTMLElement) => void) | undefined

function makeKCDWorkshopApp({
  imports,
  filesInfo,
  projectTitle,
  backend,
  ...otherWorkshopOptions
}: {
  imports: Imports
  filesInfo: Array<FileInfo>
  projectTitle: string
  backend?: Backend
  options?: {
    concurrentMode?: boolean
  }
} & {
  gitHubRepoUrl: string
}) {
  const lazyComponents: LazyComponents = {}

  const componentExtensions = ['.js', '.md', '.mdx', '.tsx', '.ts']

  for (const {ext, filePath} of filesInfo) {
    if (componentExtensions.includes(ext)) {
      lazyComponents[filePath] = React.lazy(
        moduleWithDefaultExport(imports, filePath),
      )
    }
  }

  if (backend) {
    const {
      handlers,
      quiet = true,
      serviceWorker = {url: '/mockServiceWorker.js'},
      ...rest
    } = backend
    if (process.env.NODE_ENV !== 'test') {
      const server = setupServer({handlers}) as SetupWorkerApi
      void server.start({
        quiet,
        serviceWorker,
        ...rest,
      })
    }
  }

  const history = createBrowserHistory()

  let previousLocation = history.location
  let previousIsIsolated: boolean | null = null

  function render(ui: React.ReactElement) {
    const rootEl = document.getElementById('root')
    if (rootEl) {
      unmount?.(rootEl)
    } else {
      // eslint-disable-next-line no-alert
      window.alert(
        'This document has no div with the ID of "root." Please add one... Or bug Kent about it...',
      )
      return
    }
    const root = createRoot(rootEl)
    root.render(ui)
    unmount = () => root.unmount()
  }

  function escapeForClassList(name: string) {
    // classList methods don't allow space or `/` characters
    return encodeURIComponent(name.replace(/\//g, '_'))
  }

  function handleLocationChange(location = history.location) {
    const {pathname} = location
    // add location pathname to classList of the body
    // avoid the dev-tools flash of update by not updating the class name unecessarily
    const prevClassName = escapeForClassList(previousLocation.pathname)
    const newClassName = escapeForClassList(pathname)
    if (document.body.classList.contains(prevClassName)) {
      document.body.classList.remove(
        escapeForClassList(previousLocation.pathname),
      )
    }
    if (!document.body.classList.contains(newClassName)) {
      document.body.classList.add(escapeForClassList(pathname))
    }

    // set the title to have info for the exercise
    const isIsolated = pathname.startsWith('/isolated')
    let info: FileInfo | undefined
    if (isIsolated) {
      const filePath = pathname.replace('/isolated', 'src')
      info = filesInfo.find(i => i.filePath === filePath)
    } else {
      const number = Number(pathname.split('/').slice(-1)[0])
      info = filesInfo.find(
        i => i.type === 'instruction' && i.number === number,
      )
    }

    if (isIsolated && !info) {
      document.body.innerHTML = `
        <div style="${fillScreenCenter}">
          <div>
            Sorry... nothing here. To open one of the exercises, go to
            <code>\`/exerciseNumber\`</code>, for example:
            <a href="/1"><code>/1</code></a>
          </div>
        </div>
      `
      return
    }

    // I honestly have no clue why, but there appears to be some kind of
    // race condition here with the title. It seems to get reset to the
    // title that's defined in the index.html after we set it :shrugs:
    setTimeout(() => {
      const title = [
        info
          ? [
              info.number ? `${info.number}. ` : '',
              info.title || info.filename,
            ].join('')
          : null,
        projectTitle,
      ]
        .filter(Boolean)
        .join(' | ')
      // the dev-tools flash the title as changed on HMR even
      // if it's not actually changed, so we'll only change it
      // when it's necessary:
      if (document.title !== title) {
        document.title = title
      }
    }, 20)

    if (isIsolated && info) {
      renderIsolated(moduleWithDefaultExport(imports, info.filePath))
    } else if (previousIsIsolated !== isIsolated) {
      // if we aren't going from isolated to the app, then we don't need
      // to bother rendering react anew. The app will handle that.
      renderReact()
    }
    previousLocation = location
    previousIsIsolated = isIsolated
  }

  function renderIsolated(isolatedModuleImport: DynamicImportFn) {
    void isolatedModuleImport().then(async ({default: defaultExport}) => {
      if (history.location !== previousLocation) {
        // location has changed while we were getting the module
        // so don't bother doing anything... Let the next event handler
        // deal with it
        return
      }
      if (typeof defaultExport === 'function') {
        if (defaultExport === DO_NOT_RENDER) {
          return
        }
        // regular react component.
        render(React.createElement(defaultExport))
      } else if (typeof defaultExport === 'string') {
        // HTML file
        const domParser = new DOMParser()
        const newDocument = domParser.parseFromString(
          defaultExport,
          'text/html',
        )
        document.documentElement.replaceWith(newDocument.documentElement)

        // to get all the scripts to actually run, you have to create new script
        // elements, and no, cloneElement doesn't work unfortunately.
        // Apparently, scripts will only get loaded/run if you use createElement.
        const scripts = Array.from(document.querySelectorAll('script'))
        const loadingScriptsQueue = []
        for (const script of scripts) {
          // if we're dealing with an inline script, we need to wait for all other
          // scripts to finish loading before we run it
          if (!script.hasAttribute('src')) {
            // eslint-disable-next-line no-await-in-loop
            await Promise.all(loadingScriptsQueue)
          }
          // replace the script
          const newScript = document.createElement('script')
          for (const attrName of script.getAttributeNames()) {
            newScript.setAttribute(
              attrName,
              script.getAttribute(attrName) ?? '',
            )
          }
          newScript.innerHTML = script.innerHTML
          script.parentNode?.insertBefore(newScript, script)
          script.parentNode?.removeChild(script)

          // if the new script has a src, add it to the queue
          if (script.hasAttribute('src')) {
            loadingScriptsQueue.push(
              new Promise(resolve => {
                newScript.onload = resolve
              }),
            )
          }
        }

        // now make sure all src scripts are loaded before continuing
        await Promise.all(loadingScriptsQueue)

        // Babel will call this when the DOMContentLoaded event fires
        // but because the content has already loaded, that event will never
        // fire, so we'll run it ourselves
        if (window.Babel) {
          window.Babel.transformScriptTags()
        }
      }

      // otherwise we'll just expect that the file ran the thing it was supposed
      // to run and doesn't need any help.
    })
  }

  function renderReact() {
    if (document.documentElement !== originalDocumentElement) {
      document.documentElement.replaceWith(originalDocumentElement)
    }
    renderReactApp({
      history,
      projectTitle,
      filesInfo,
      lazyComponents,
      render,
      ...otherWorkshopOptions,
    })
  }

  history.listen(handleLocationChange)
  // kick it off to get us started
  handleLocationChange()
}

// React.lazy *requires* that you pass it a promise that resolves to a default export
// of a function that returns JSX.Element. But we want to be able to dynamically
// import a function that we don't actually render (because that file will render itself manually)
// so we use this as the fallback for that situation and explicitely do not bother rendering it
function DO_NOT_RENDER() {
  return <></>
}

function moduleWithDefaultExport(
  imports: Imports,
  filePath: string,
): DefaultDynamicImportFn {
  const importFn = imports[filePath]
  if (!importFn) throw new Error(`'${filePath}' does not exist in imports.`)

  if (filePath.endsWith('html')) {
    return importFn as DefaultDynamicImportFn
  }
  return function importJS() {
    return importFn().then(
      module => {
        if (filePath.match(/\.mdx?$/)) targetBlankifyInstructionLinks()
        return {default: module.App ?? module.default ?? DO_NOT_RENDER}
      },
      error => {
        console.error('Error importing a JS file', filePath, error)
        return {default: () => <div>{(error as Error).message}</div>}
      },
    )
  }
}

// this is a pain, but we need to add target="_blank" to all the links
// in the markdown and even though I tried with useEffect, I couldn't
// get my useEffect to run *after* the markdown was rendered, so we're
// pulling this hack together 🙄
function targetBlankifyInstructionLinks() {
  setTimeout(() => {
    const instructionContainer = document.querySelector(
      '.instruction-container',
    )
    // this shouldn't happen, but it could...
    if (!instructionContainer) return

    const anchors = Array.from(instructionContainer.querySelectorAll('a'))
    for (const anchor of anchors) {
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noopener noreferrer nofollow')
    }
  }, 200)
}

export {makeKCDWorkshopApp}

/*
eslint
  babel/no-unused-expressions: "off",
  @typescript-eslint/no-explicit-any: "off",
  @typescript-eslint/prefer-regexp-exec: "off",
  react/jsx-no-useless-fragment: "off",
  no-void: "off"
*/
