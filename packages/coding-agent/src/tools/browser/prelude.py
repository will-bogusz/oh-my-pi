def _make_browser():
    import re
    from types import MappingProxyType

    def _require_name(name, label):
        if not isinstance(name, str) or not name:
            raise TypeError(f"{label} expects a tab name")
        return name

    def _encode_arg(value):
        if isinstance(value, re.Pattern):
            if not isinstance(value.pattern, str):
                raise TypeError("browser helpers require regular expressions with string patterns")
            flags = ""
            if value.flags & re.IGNORECASE:
                flags += "i"
            if value.flags & re.MULTILINE:
                flags += "m"
            if value.flags & re.DOTALL:
                flags += "s"
            return {"__omp_re": {"source": value.pattern, "flags": flags}}
        return value

    def _arguments(args, kwargs):
        values = list(args)
        while values and values[-1] is None:
            values.pop()
        values = [_encode_arg(value) for value in values]
        options = {
            key: _encode_arg(value)
            for key, value in kwargs.items()
            if value is not None
        }
        if options:
            values.append(options)
        return values

    async def _invoke(action, options):
        response = await _omp_prelude(
            "browser",
            {
                **{
                    key: value
                    for key, value in options.items()
                    if value is not None
                },
                "action": action,
            },
        )
        if not isinstance(response, dict):
            raise RuntimeError("browser returned an invalid response")
        text = response.get("text")
        if isinstance(text, str) and text:
            print(text)
        details = response.get("details")
        if not isinstance(details, dict):
            raise RuntimeError("browser returned invalid response details")
        return details

    async def _call(name, chain, handle=None):
        details = await _invoke("call", {"name": name, "chain": chain, "handle": handle})
        return details.get("value")

    class _Element:
        __slots__ = ("_name", "_handle_method", "_handle_value", "_handle")

        def __init__(self, name, handle_method, handle_value, handle=None):
            self._name = name
            self._handle_method = handle_method
            self._handle_value = handle_value
            self._handle = handle

        def __repr__(self):
            return (
                f"<browser.Element tab={self._name!r} "
                f"{self._handle_method}={self._handle_value!r}>"
            )

        async def _method(self, method, args, kwargs):
            return await _call(
                self._name,
                [
                    {"method": self._handle_method, "args": [self._handle_value]},
                    {"method": method, "args": _arguments(args, kwargs)},
                ],
                self._handle,
            )

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def dblclick(self, *args, **kwargs):
            return await self._method("dblclick", args, kwargs)

        async def check(self, *args, **kwargs):
            return await self._method("check", args, kwargs)

        async def uncheck(self, *args, **kwargs):
            return await self._method("uncheck", args, kwargs)

        async def highlight(self, *args, **kwargs):
            return await self._method("highlight", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def fill(self, *args, **kwargs):
            return await self._method("fill", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def hover(self, *args, **kwargs):
            return await self._method("hover", args, kwargs)

        async def focus(self, *args, **kwargs):
            return await self._method("focus", args, kwargs)

        async def select(self, *args, **kwargs):
            return await self._method("select", args, kwargs)

        async def uploadFile(self, *args, **kwargs):
            return await self._method("uploadFile", args, kwargs)

        async def scrollIntoView(self, *args, **kwargs):
            return await self._method("scrollIntoView", args, kwargs)

        async def boundingBox(self, *args, **kwargs):
            return await self._method("boundingBox", args, kwargs)

        async def isVisible(self, *args, **kwargs):
            return await self._method("isVisible", args, kwargs)

        async def isHidden(self, *args, **kwargs):
            return await self._method("isHidden", args, kwargs)

        async def text(self, *args, **kwargs):
            return await self._method("text", args, kwargs)

        async def html(self, *args, **kwargs):
            return await self._method("html", args, kwargs)

        async def value(self, *args, **kwargs):
            return await self._method("value", args, kwargs)

        async def attr(self, *args, **kwargs):
            return await self._method("attr", args, kwargs)

        async def styles(self, *args, **kwargs):
            return await self._method("styles", args, kwargs)

        async def isEnabled(self, *args, **kwargs):
            return await self._method("isEnabled", args, kwargs)

        async def isChecked(self, *args, **kwargs):
            return await self._method("isChecked", args, kwargs)

        async def evaluate(self, *args, **kwargs):
            return await self._method("evaluate", args, kwargs)

    # Name -> (handle, target) of a managed Chrome tab, so `browser.tab(name)` keeps its identity.
    _identities_by_name = {}

    class _Frame:
        __slots__ = ("_name", "_selector", "_handle")

        def __init__(self, name, selector, handle=None):
            self._name = name
            self._selector = selector
            self._handle = handle

        def __repr__(self):
            return f"<browser.Frame tab={self._name!r} selector={self._selector!r}>"

        async def _method(self, method, args, kwargs):
            return await _call(
                self._name,
                [
                    {"method": "frame", "args": [self._selector]},
                    {"method": method, "args": _arguments(args, kwargs)},
                ],
                self._handle,
            )

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def fill(self, *args, **kwargs):
            return await self._method("fill", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def text(self, *args, **kwargs):
            return await self._method("text", args, kwargs)

        async def html(self, *args, **kwargs):
            return await self._method("html", args, kwargs)

        async def value(self, *args, **kwargs):
            return await self._method("value", args, kwargs)

        async def attr(self, *args, **kwargs):
            return await self._method("attr", args, kwargs)

        async def count(self, *args, **kwargs):
            return await self._method("count", args, kwargs)

        async def isVisible(self, *args, **kwargs):
            return await self._method("isVisible", args, kwargs)

        async def ariaSnapshot(self, *args, **kwargs):
            return await self._method("ariaSnapshot", args, kwargs)

        async def evaluate(self, *args, **kwargs):
            return await self._method("evaluate", args, kwargs)

        async def waitFor(self, *args, **kwargs):
            return await self._method("waitFor", args, kwargs)

        async def waitForSelector(self, *args, **kwargs):
            return await self._method("waitForSelector", args, kwargs)

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)


    class _Observation(dict):
        """An observation reads as its tree: `str(obs)`, `f"{obs}"`, `print(obs)`."""

        __slots__ = ()

        def __str__(self):
            return self["tree"]

    class _Tab:
        __slots__ = ("_name", "_handle", "_snapshot", "_initial", "_target")

        def __init__(self, name, handle=None, initial=None):
            self._name = _require_name(name, "tab name")
            self._handle = handle
            self._initial = initial or {}
            if isinstance(self._initial.get("initialObservation"), dict):
                self._initial["initialObservation"] = _Observation(self._initial["initialObservation"])
            self._snapshot = (self._initial.get("initialObservation") or {}).get("snapshot")
            target = self._initial.get("target")
            if target:
                self._target = MappingProxyType({key: target[key] for key in ("id", "browserId", "tabId")})
            else:
                remembered = _identities_by_name.get(self._name)
                self._target = remembered[1] if remembered else None
            if handle:
                _identities_by_name[self._name] = (handle, self._target)

        @property
        def target(self):
            return self._target

        @property
        def initialDialog(self):
            return self._initial.get("initialDialog")

        @property
        def initialObservation(self):
            return self._initial.get("initialObservation")

        @property
        def initialScreenshot(self):
            return self._initial.get("initialScreenshot")

        @property
        def inspectionError(self):
            return self._initial.get("inspectionError")

        @property
        def screenshotError(self):
            return self._initial.get("screenshotError")

        @property
        def name(self):
            """The host-side tab name used by this handle."""
            return self._name

        def __repr__(self):
            target = f" target['id']={self._target['id']!r}" if self._target else ""
            return f"<browser.Tab name={self._name!r}{target}>"

        async def _method(self, method, args, kwargs):
            value = await _call(
                self._name,
                [{"method": method, "args": _arguments(args, kwargs)}],
                self._handle,
            )
            if method == "observe" and isinstance(value, dict):
                value = _Observation(value)
                self._snapshot = value.get("snapshot")
            if method == "goto":
                self._snapshot = None
            return value

        async def url(self, *args, **kwargs):
            return await self._method("url", args, kwargs)

        async def title(self, *args, **kwargs):
            return await self._method("title", args, kwargs)

        async def goto(self, *args, **kwargs):
            return await self._method("goto", args, kwargs)

        async def back(self, *args, **kwargs):
            return await self._method("back", args, kwargs)

        async def forward(self, *args, **kwargs):
            return await self._method("forward", args, kwargs)

        async def reload(self, *args, **kwargs):
            return await self._method("reload", args, kwargs)

        async def pushState(self, *args, **kwargs):
            return await self._method("pushState", args, kwargs)

        async def frames(self, *args, **kwargs):
            return await self._method("frames", args, kwargs)

        async def dialog(self, *args, **kwargs):
            return await self._method("dialog", args, kwargs)

        async def handleDialog(self, *args, **kwargs):
            return await self._method("handleDialog", args, kwargs)

        async def setDialogs(self, *args, **kwargs):
            return await self._method("setDialogs", args, kwargs)

        async def observe(self, *args, **kwargs):
            return await self._method("observe", args, kwargs)

        async def ariaSnapshot(self, *args, **kwargs):
            return await self._method("ariaSnapshot", args, kwargs)

        async def a11y(self, *args, **kwargs):
            return await self._method("a11y", args, kwargs)

        async def webmcpList(self, *args, **kwargs):
            return await self._method("webmcpList", args, kwargs)

        async def webmcpInvoke(self, *args, **kwargs):
            return await self._method("webmcpInvoke", args, kwargs)

        async def webmcpEvents(self, *args, **kwargs):
            return await self._method("webmcpEvents", args, kwargs)

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)

        async def diffScreenshot(self, *args, **kwargs):
            return await self._method("diffScreenshot", args, kwargs)

        async def pdf(self, *args, **kwargs):
            return await self._method("pdf", args, kwargs)

        async def extract(self, *args, **kwargs):
            return await self._method("extract", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def dblclick(self, *args, **kwargs):
            return await self._method("dblclick", args, kwargs)

        async def hover(self, *args, **kwargs):
            return await self._method("hover", args, kwargs)

        async def focus(self, *args, **kwargs):
            return await self._method("focus", args, kwargs)

        async def check(self, *args, **kwargs):
            return await self._method("check", args, kwargs)

        async def uncheck(self, *args, **kwargs):
            return await self._method("uncheck", args, kwargs)

        async def keyDown(self, *args, **kwargs):
            return await self._method("keyDown", args, kwargs)

        async def keyUp(self, *args, **kwargs):
            return await self._method("keyUp", args, kwargs)

        async def mouseMove(self, *args, **kwargs):
            return await self._method("mouseMove", args, kwargs)

        async def mouseDown(self, *args, **kwargs):
            return await self._method("mouseDown", args, kwargs)

        async def mouseUp(self, *args, **kwargs):
            return await self._method("mouseUp", args, kwargs)

        async def clickAt(self, *args, **kwargs):
            return await self._method("clickAt", args, kwargs)

        async def wheel(self, *args, **kwargs):
            return await self._method("wheel", args, kwargs)

        async def highlight(self, *args, **kwargs):
            return await self._method("highlight", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def fill(self, *args, **kwargs):
            return await self._method("fill", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def scroll(self, *args, **kwargs):
            return await self._method("scroll", args, kwargs)

        async def drag(self, *args, **kwargs):
            return await self._method("drag", args, kwargs)

        async def scrollIntoView(self, *args, **kwargs):
            return await self._method("scrollIntoView", args, kwargs)

        async def select(self, *args, **kwargs):
            return await self._method("select", args, kwargs)

        async def uploadFile(self, *args, **kwargs):
            return await self._method("uploadFile", args, kwargs)

        async def waitForUrl(self, *args, **kwargs):
            return await self._method("waitForUrl", args, kwargs)

        async def popups(self):
            if not self._handle:
                raise ValueError("Popup discovery requires an existing managed Chrome handle")
            return (await _invoke("popups", {"handle": self._handle})).get("value")

        async def evaluate(self, *args, **kwargs):
            return await self._method("evaluate", args, kwargs)

        async def waitFor(self, *args, **kwargs):
            return await self._method("waitFor", args, kwargs)

        async def waitForSelector(self, *args, **kwargs):
            return await self._method("waitForSelector", args, kwargs)

        async def text(self, *args, **kwargs):
            return await self._method("text", args, kwargs)

        async def html(self, *args, **kwargs):
            return await self._method("html", args, kwargs)

        async def value(self, *args, **kwargs):
            return await self._method("value", args, kwargs)

        async def attr(self, *args, **kwargs):
            return await self._method("attr", args, kwargs)

        async def count(self, *args, **kwargs):
            return await self._method("count", args, kwargs)

        async def box(self, *args, **kwargs):
            return await self._method("box", args, kwargs)

        async def styles(self, *args, **kwargs):
            return await self._method("styles", args, kwargs)

        async def isVisible(self, *args, **kwargs):
            return await self._method("isVisible", args, kwargs)

        async def isEnabled(self, *args, **kwargs):
            return await self._method("isEnabled", args, kwargs)

        async def isChecked(self, *args, **kwargs):
            return await self._method("isChecked", args, kwargs)

        async def waitForText(self, *args, **kwargs):
            return await self._method("waitForText", args, kwargs)

        async def emulate(self, *args, **kwargs):
            return await self._method("emulate", args, kwargs)

        async def devices(self, *args, **kwargs):
            return await self._method("devices", args, kwargs)

        async def clipboardRead(self, *args, **kwargs):
            return await self._method("clipboardRead", args, kwargs)

        async def clipboardWrite(self, *args, **kwargs):
            return await self._method("clipboardWrite", args, kwargs)

        async def clipboardCopy(self, *args, **kwargs):
            return await self._method("clipboardCopy", args, kwargs)

        async def clipboardPaste(self, *args, **kwargs):
            return await self._method("clipboardPaste", args, kwargs)

        async def cookies(self, *args, **kwargs):
            return await self._method("cookies", args, kwargs)

        async def setCookies(self, *args, **kwargs):
            return await self._method("setCookies", args, kwargs)

        async def clearCookies(self, *args, **kwargs):
            return await self._method("clearCookies", args, kwargs)

        async def storage(self, *args, **kwargs):
            return await self._method("storage", args, kwargs)

        async def setStorage(self, *args, **kwargs):
            return await self._method("setStorage", args, kwargs)

        async def clearStorage(self, *args, **kwargs):
            return await self._method("clearStorage", args, kwargs)

        async def saveState(self, *args, **kwargs):
            return await self._method("saveState", args, kwargs)

        async def loadState(self, *args, **kwargs):
            return await self._method("loadState", args, kwargs)

        async def addInitScript(self, *args, **kwargs):
            return await self._method("addInitScript", args, kwargs)

        async def removeInitScript(self, *args, **kwargs):
            return await self._method("removeInitScript", args, kwargs)

        async def initScripts(self, *args, **kwargs):
            return await self._method("initScripts", args, kwargs)

        async def waitForDownload(self, *args, **kwargs):
            return await self._method("waitForDownload", args, kwargs)

        async def downloads(self, *args, **kwargs):
            return await self._method("downloads", args, kwargs)

        async def console(self, *args, **kwargs):
            return await self._method("console", args, kwargs)

        async def errors(self, *args, **kwargs):
            return await self._method("errors", args, kwargs)

        async def clearConsole(self, *args, **kwargs):
            return await self._method("clearConsole", args, kwargs)

        async def traceStart(self, *args, **kwargs):
            return await self._method("traceStart", args, kwargs)

        async def traceStop(self, *args, **kwargs):
            return await self._method("traceStop", args, kwargs)

        async def profileStart(self, *args, **kwargs):
            return await self._method("profileStart", args, kwargs)

        async def profileStop(self, *args, **kwargs):
            return await self._method("profileStop", args, kwargs)

        async def metrics(self, *args, **kwargs):
            return await self._method("metrics", args, kwargs)

        async def route(self, *args, **kwargs):
            return await self._method("route", args, kwargs)

        async def unroute(self, *args, **kwargs):
            return await self._method("unroute", args, kwargs)

        async def routes(self, *args, **kwargs):
            return await self._method("routes", args, kwargs)

        async def requests(self, *args, **kwargs):
            return await self._method("requests", args, kwargs)

        async def request(self, *args, **kwargs):
            return await self._method("request", args, kwargs)

        async def clearRequests(self, *args, **kwargs):
            return await self._method("clearRequests", args, kwargs)

        async def harStart(self, *args, **kwargs):
            return await self._method("harStart", args, kwargs)

        async def harStop(self, *args, **kwargs):
            return await self._method("harStop", args, kwargs)

        async def allowedDomains(self, *args, **kwargs):
            return await self._method("allowedDomains", args, kwargs)

        async def vitals(self, *args, **kwargs):
            return await self._method("vitals", args, kwargs)

        async def reactEnable(self, *args, **kwargs):
            return await self._method("reactEnable", args, kwargs)

        async def reactTree(self, *args, **kwargs):
            return await self._method("reactTree", args, kwargs)

        async def reactInspect(self, *args, **kwargs):
            return await self._method("reactInspect", args, kwargs)

        async def reactRenders(self, *args, **kwargs):
            return await self._method("reactRenders", args, kwargs)

        async def reactSuspense(self, *args, **kwargs):
            return await self._method("reactSuspense", args, kwargs)

        async def recordStart(self, *args, **kwargs):
            return await self._method("recordStart", args, kwargs)

        async def recordStop(self, *args, **kwargs):
            return await self._method("recordStop", args, kwargs)

        async def recordRestart(self, *args, **kwargs):
            return await self._method("recordRestart", args, kwargs)

        async def recording(self, *args, **kwargs):
            return await self._method("recording", args, kwargs)

        def id(self, element_id):
            """Return a synchronous handle for a numeric observed element id."""
            if isinstance(element_id, bool) or not isinstance(element_id, int):
                raise TypeError("tab.id() expects an integer element id")
            return _Element(self._name, "ref" if self._snapshot else "id",
                            f"{self._snapshot}:{element_id}" if self._snapshot else element_id, self._handle)

        def ref(self, ref_id):
            """Return a synchronous handle for an observation ref or an ARIA reference id."""
            if not isinstance(ref_id, str) or not ref_id:
                raise TypeError("tab.ref() expects a non-empty reference id")
            return _Element(self._name, "ref", ref_id, self._handle)

        def frame(self, selector_or_name_or_url):
            """Return a synchronous proxy for a child frame."""
            if not isinstance(selector_or_name_or_url, str) or not selector_or_name_or_url:
                raise TypeError("tab.frame() expects a non-empty selector, name, or URL")
            return _Frame(self._name, selector_or_name_or_url, self._handle)

        async def run(self, code, **options):
            """Run a JavaScript code string in this tab and return its value."""
            if not isinstance(code, str) or not code.strip():
                raise TypeError("tab.run() expects a JavaScript code string")
            details = await _invoke("run", {**options, "name": self._name, "code": code, "handle": self._handle})
            return details.get("value")

        async def close(self, **options):
            """Close this tab handle's host-side tab."""
            if (_identities_by_name.get(self._name) or (None,))[0] == self._handle:
                _identities_by_name.pop(self._name, None)
            await _invoke("close", {**options, "name": self._name, "handle": self._handle})

        async def reveal(self):
            await _invoke("reveal", {"handle": self._handle})

        async def release(self):
            if (_identities_by_name.get(self._name) or (None,))[0] == self._handle:
                _identities_by_name.pop(self._name, None)
            await _invoke("release", {"handle": self._handle})

    # Verb options (and tab.run/tab.close's) pass through whole: the host checks
    # them against the declared API and names the keys a verb takes.
    class _Browser:
        __slots__ = ()

        def __repr__(self):
            return "<browser>"

        async def open(self, **options):
            """Open or attach to a browser tab and return its handle."""
            if options.get("name") is not None:
                _require_name(options["name"], "browser.open()")
            details = await _invoke("open", options)
            opened_name = details.get("name")
            if not isinstance(opened_name, str) or not opened_name:
                raise RuntimeError("browser.open() returned an invalid tab name")
            return _Tab(opened_name, details.get("handle"), details.get("value"))

        async def instances(self):
            return (await _invoke("instances", {})).get("value")

        async def help(self):
            """Print the typed browser API: every interface and signature the handles expose."""
            await _invoke("help", {})

        async def discover(self, **options):
            return (await _invoke("discover", options)).get("value")

        async def closeTab(self, tab_id, **options):
            if not isinstance(tab_id, str) or not tab_id:
                raise TypeError(
                    "browser.closeTab expects an exact discovered tab id (a tab's own is tab.target['id']; tab.id(n) is an element)"
                )
            await _invoke("closeTab", {**options, "id": tab_id})

        async def create(self, **options):
            details = await _invoke("create", options)
            return _Tab(details.get("name"), details.get("handle"), details.get("value"))

        async def claim(self, tab_id, **options):
            if not isinstance(tab_id, str) or not tab_id:
                raise TypeError(
                    "browser.claim expects an exact discovered tab id (a tab's own is tab.target['id']; tab.id(n) is an element)"
                )
            details = await _invoke("claim", {**options, "id": tab_id})
            return _Tab(details.get("name"), details.get("handle"), details.get("value"))

        async def getTab(self, selector, **options):
            if isinstance(selector, str):
                target = {"id": selector}
            elif isinstance(selector, dict):
                target = {"selector": selector}
            else:
                raise TypeError("browser.getTab expects an exact discovery id or a selector dictionary")
            details = await _invoke("claim", {**options, **target})
            return _Tab(details.get("name"), details.get("handle"), details.get("value"))

        def tab(self, name="main"):
            """Re-acquire a synchronous handle for an existing named tab."""
            # Managed Chrome tabs are addressed by their immutable handle, never
            # by the display label, so a name lookup has to carry the handle.
            resolved = _require_name(name, "browser.tab()")
            return _Tab(resolved, (_identities_by_name.get(resolved) or (None,))[0])

        async def tabs(self):
            """List managed browser tabs."""
            details = await _invoke("tabs", {})
            value = details.get("value")
            return value if isinstance(value, list) else []

        async def close(self, **options):
            """Close one or all managed browser tabs."""
            if options.get("name") is not None:
                _require_name(options["name"], "browser.close()")
            await _invoke("close", options)

    return _Browser()


browser = _make_browser()
del _make_browser
