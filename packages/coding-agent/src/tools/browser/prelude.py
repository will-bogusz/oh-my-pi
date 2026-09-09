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

        async def evaluate(self, *args, **kwargs):
            return await self._method("evaluate", args, kwargs)

    # Name -> (handle, target) of a managed Chrome tab, so `browser.tab(name)` keeps its identity.
    _identities_by_name = {}

    class _Tab:
        __slots__ = ("_name", "_handle", "_snapshot", "_initial", "_target")

        def __init__(self, name, handle=None, initial=None):
            self._name = _require_name(name, "tab name")
            self._handle = handle
            self._initial = initial or {}
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
        def initialTree(self):
            return self._initial.get("initialTree")

        @property
        def initialScreenshot(self):
            return self._initial.get("initialScreenshot")

        @property
        def inspectionError(self):
            return self._initial.get("inspectionError")

        @property
        def treeError(self):
            return self._initial.get("treeError")

        @property
        def screenshotError(self):
            return self._initial.get("screenshotError")

        @property
        def name(self):
            """The host-side tab name used by this handle."""
            return self._name

        def __repr__(self):
            target = f" target={self._target['id']!r}" if self._target else ""
            return f"<browser.Tab name={self._name!r}{target}>"

        async def _method(self, method, args, kwargs):
            value = await _call(
                self._name,
                [{"method": method, "args": _arguments(args, kwargs)}],
                self._handle,
            )
            if method == "observe" and isinstance(value, dict):
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

        async def observe(self, *args, **kwargs):
            return await self._method("observe", args, kwargs)

        async def ariaSnapshot(self, *args, **kwargs):
            return await self._method("ariaSnapshot", args, kwargs)

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)

        async def extract(self, *args, **kwargs):
            return await self._method("extract", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

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

        async def dialog(self, options=None, **kwargs):
            if not self._handle:
                raise ValueError("Dialog inspection requires an existing managed Chrome handle")
            if options is not None and (not isinstance(options, dict) or kwargs):
                raise TypeError("dialog accepts one options dictionary or keyword arguments")
            details = await _invoke("dialog", {"handle": self._handle, "dialog": options if options is not None else kwargs})
            return details.get("value")

        async def popups(self):
            if not self._handle:
                raise ValueError("Popup discovery requires an existing managed Chrome handle")
            return (await _invoke("popups", {"handle": self._handle})).get("value")

        async def downloads(self, *args, **kwargs):
            return await self._method("downloads", args, kwargs)

        async def evaluate(self, *args, **kwargs):
            return await self._method("evaluate", args, kwargs)

        async def waitFor(self, *args, **kwargs):
            return await self._method("waitFor", args, kwargs)

        async def waitForSelector(self, *args, **kwargs):
            return await self._method("waitForSelector", args, kwargs)

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

        async def run(self, code, *, timeout=None):
            """Run a JavaScript code string in this tab and return its value."""
            if not isinstance(code, str) or not code.strip():
                raise TypeError("tab.run() expects a JavaScript code string")
            details = await _invoke(
                "run",
                {"name": self._name, "code": code, "timeout": timeout, "handle": self._handle},
            )
            return details.get("value")

        async def close(self, *, kill=None, timeout=None):
            """Close this tab handle's host-side tab."""
            if (_identities_by_name.get(self._name) or (None,))[0] == self._handle:
                _identities_by_name.pop(self._name, None)
            await _invoke(
                "close",
                {"name": self._name, "kill": kill, "timeout": timeout, "handle": self._handle},
            )

        async def reveal(self):
            await _invoke("reveal", {"handle": self._handle})

        async def keep(self):
            """Leave this page open for the user when the task ends."""
            await _invoke("keep", {"handle": self._handle})

        async def release(self):
            if (_identities_by_name.get(self._name) or (None,))[0] == self._handle:
                _identities_by_name.pop(self._name, None)
            await _invoke("release", {"handle": self._handle})

    class _Browser:
        __slots__ = ()

        def __repr__(self):
            return "<browser>"

        async def open(
            self,
            *,
            name=None,
            url=None,
            app=None,
            viewport=None,
            wait_until=None,
            dialogs=None,
            timeout=None,
            persist=None,
            observation=None,
        ):
            """Open or attach to a browser tab and return its handle."""
            if name is not None:
                _require_name(name, "browser.open()")
            details = await _invoke(
                "open",
                {
                    "name": name,
                    "url": url,
                    "app": app,
                    "viewport": viewport,
                    "wait_until": wait_until,
                    "dialogs": dialogs,
                    "timeout": timeout,
                    "persist": persist,
                    "observation": observation,
                },
            )
            opened_name = details.get("name")
            if not isinstance(opened_name, str) or not opened_name:
                raise RuntimeError("browser.open() returned an invalid tab name")
            return _Tab(opened_name, details.get("handle"), details.get("value"))

        async def instances(self):
            return (await _invoke("instances", {})).get("value")

        async def discover(self, *, browserId=None):
            return (await _invoke("discover", {"browserId": browserId})).get("value")

        async def closeTab(self, tab_id, *, browserId=None, timeout=None):
            if not isinstance(tab_id, str) or not tab_id:
                raise TypeError("browser.closeTab expects an exact discovered tab id")
            await _invoke("closeTab", {"id": tab_id, "browserId": browserId, "timeout": timeout})

        async def create(self, *, url=None, label=None, timeout=None, browserId=None, observation=None):
            details = await _invoke("create", {"url": url, "label": label, "timeout": timeout, "browserId": browserId, "observation": observation})
            return _Tab(details.get("name"), details.get("handle"), details.get("value"))

        async def claim(self, tab_id, *, label=None, timeout=None, browserId=None, observation=None):
            details = await _invoke("claim", {"id": tab_id, "label": label, "timeout": timeout, "browserId": browserId, "observation": observation})
            return _Tab(details.get("name"), details.get("handle"), details.get("value"))

        async def getTab(self, selector, *, label=None, timeout=None, observation=None):
            if isinstance(selector, str):
                target = {"id": selector}
            elif isinstance(selector, dict):
                target = {"selector": selector}
            else:
                raise TypeError("browser.getTab expects an exact discovery id or a selector dictionary")
            details = await _invoke("claim", {**target, "label": label, "timeout": timeout, "observation": observation})
            return _Tab(details.get("name"), details.get("handle"), details.get("value"))

        def tab(self, name="main"):
            """Re-acquire a synchronous handle for an existing named tab."""
            # Managed Chrome tabs are addressed by their immutable handle, never
            # by the display label, so a name lookup has to carry the handle.
            resolved = _require_name(name, "browser.tab()")
            return _Tab(resolved, (_identities_by_name.get(resolved) or (None,))[0])

        async def close(self, *, name=None, all=None, kill=None, timeout=None):
            """Close one or all managed browser tabs."""
            if name is not None:
                _require_name(name, "browser.close()")
            await _invoke(
                "close",
                {"name": name, "all": all, "kill": kill, "timeout": timeout},
            )

    return _Browser()


browser = _make_browser()
del _make_browser
