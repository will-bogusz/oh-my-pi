def _make_computer():
    import re
    from types import MappingProxyType

    def _encode_arg(value):
        if isinstance(value, MappingProxyType):
            return dict(value)
        if isinstance(value, re.Pattern):
            if not isinstance(value.pattern, str):
                raise TypeError("computer helpers require regular expressions with string patterns")
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
            "computer",
            {
                **{
                    key: value
                    for key, value in options.items()
                    if value is not None
                },
                "action": action,
            },
        )
        if isinstance(response, str):
            return {}
        if not isinstance(response, dict):
            raise RuntimeError("computer returned an invalid response")
        text = response.get("text")
        if isinstance(text, str) and text:
            print(text)
        details = response.get("details")
        return details if isinstance(details, dict) else {}

    async def _call(chain):
        details = await _invoke("call", {"chain": chain})
        return details.get("value")

    def _step(method, args, kwargs):
        return {"method": method, "args": _arguments(args, kwargs)}

    class _Element:
        __slots__ = ("ref", "role", "subrole", "label", "value", "placeholder", "help", "description", "enabled", "selected", "actions", "bounds", "pid", "windowId", "_owner")

        def __init__(self, snapshot, identity=None):
            for field in _Element.__slots__:
                if field == "_owner":
                    continue
                value = snapshot.get(field)
                if field == "bounds" and isinstance(value, dict):
                    value = MappingProxyType(dict(value))
                if field == "actions" and isinstance(value, list):
                    value = tuple(value)
                object.__setattr__(self, field, value)
            owner = identity
            if owner is None and self.windowId is not None and self.pid is not None:
                owner = {"id": self.windowId, "pid": self.pid}
            object.__setattr__(self, "_owner", MappingProxyType(dict(owner)) if owner is not None else None)

        def __setattr__(self, name, value):
            raise AttributeError("computer element fields are immutable observation data")

        def __repr__(self):
            return f"<computer.Element ref={self.ref!r} role={self.role!r}>"

        async def _method(self, method, args, kwargs):
            chain = [_step("window", (dict(self._owner),), {})] if self._owner is not None else []
            return await _call([*chain, _step("ref", (self.ref,), {}), _step(method, args, kwargs)])

        async def setValue(self, *args, **kwargs):
            return await self._method("setValue", args, kwargs)

        async def perform(self, *args, **kwargs):
            return await self._method("perform", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def doubleClick(self, *args, **kwargs):
            return await self._method("doubleClick", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def scroll(self, *args, **kwargs):
            return await self._method("scroll", args, kwargs)


    class _LazyElement(_Element):
        """An `_Element` built from a bare ref; awaiting it fetches the full snapshot."""
        __slots__ = ("_resolve",)

        def __init__(self, snapshot, identity, resolve):
            super().__init__(snapshot, identity)
            object.__setattr__(self, "_resolve", resolve)

        def __await__(self):
            return self._resolve().__await__()

    class _Window:
        __slots__ = ("id", "app", "title", "pid", "bounds", "onScreen", "layer", "zIndex", "kind", "initialObservation", "inspectionError", "initialScreenshot", "screenshotError")

        def __init__(self, snapshot):
            if not isinstance(snapshot.get("id"), str) or type(snapshot.get("pid")) is not int:
                raise TypeError("computer window snapshot requires an exact id and PID")
            for field in self.__slots__:
                value = snapshot.get(field)
                if field == "bounds" and isinstance(value, dict):
                    value = MappingProxyType(dict(value))
                object.__setattr__(self, field, value)

        def __setattr__(self, name, value):
            raise AttributeError("computer window fields are immutable observation data")

        def __repr__(self):
            return f"<computer.Window id={self.id!r} app={self.app!r}>"

        async def _method(self, method, args, kwargs):
            return await _call([_step("window", ({"id": self.id, "pid": self.pid},), {}), _step(method, args, kwargs)])

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def doubleClick(self, *args, **kwargs):
            return await self._method("doubleClick", args, kwargs)

        async def hover(self, *args, **kwargs):
            return await self._method("hover", args, kwargs)

        async def drag(self, *args, **kwargs):
            return await self._method("drag", args, kwargs)

        async def scroll(self, *args, **kwargs):
            return await self._method("scroll", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def reveal(self, *args, **kwargs):
            return await self._method("reveal", args, kwargs)

        async def observe(self, *args, **kwargs):
            return await self._method("observe", args, kwargs)

        async def setValue(self, *args, **kwargs):
            return await self._method("setValue", args, kwargs)

        async def setFrame(self, *args, **kwargs):
            return await self._method("setFrame", args, kwargs)

        async def menu(self, *args, **kwargs):
            return await self._method("menu", args, kwargs)

        async def verify(self, *args, **kwargs):
            return await _call([_step("verifyWindow", ({"id": self.id, "pid": self.pid}, *args), kwargs)])

        async def find(self, *args, **kwargs):
            return [_Element(snapshot, {"id": self.id, "pid": self.pid}) for snapshot in await self._method("find", args, kwargs)]

        def ref(self, ref):
            """A ref handle: act directly (`await win.ref(r).click()`) or `await win.ref(r)` for the snapshot."""
            identity = {"id": self.id, "pid": self.pid}

            async def resolve():
                snapshot = await self._method("ref", (ref,), {})
                return _Element(snapshot, identity) if isinstance(snapshot, dict) else None

            return _LazyElement({"ref": ref}, identity, resolve)

    class _Clipboard:
        __slots__ = ()

        async def read(self):
            return await _call([_step("clipboard.read", (), {})])

        async def write(self, text):
            return await _call([_step("clipboard.write", (text,), {})])

    class _Computer:
        __slots__ = ("clipboard",)

        def __init__(self):
            self.clipboard = _Clipboard()

        def __repr__(self):
            return "<computer>"

        async def _method(self, method, args, kwargs):
            return await _call([_step(method, args, kwargs)])

        async def apps(self, *args, **kwargs):
            return await self._method("apps", args, kwargs)

        async def launch(self, *args, **kwargs):
            return await self._method("launch", args, kwargs)

        async def displays(self, *args, **kwargs):
            return await self._method("displays", args, kwargs)

        async def windows(self, *args, **kwargs):
            return await self._method("windows", args, kwargs)

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def doubleClick(self, *args, **kwargs):
            return await self._method("doubleClick", args, kwargs)

        async def move(self, *args, **kwargs):
            return await self._method("move", args, kwargs)

        async def drag(self, *args, **kwargs):
            return await self._method("drag", args, kwargs)

        async def scroll(self, *args, **kwargs):
            return await self._method("scroll", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def window(self, *args, launch=None, ambiguous=None, screenshot=None, silent=None, maxDepth=None, maxElements=None, query=None, **kwargs):
            """Acquire one exact window and its initial background inspection."""
            selectors = _arguments(args, kwargs)
            if len(selectors) != 1:
                raise TypeError("computer.window expects one selector or filter keywords")
            options = {key: value for key, value in {"launch": launch, "ambiguous": ambiguous, "screenshot": screenshot, "silent": silent, "maxDepth": maxDepth, "maxElements": maxElements, "query": query}.items() if value is not None}
            snapshot = await self._method("acquireWindow", (selectors[0], options), {})
            return _Window(snapshot) if isinstance(snapshot, dict) else None

        async def focusedWindow(self):
            snapshot = await self._method("focusedWindow", (), {})
            return _Window(snapshot) if isinstance(snapshot, dict) else None

        def ref(self, ref):
            """A ref handle: act directly or await it for snapshot data (not native liveness)."""

            async def resolve():
                snapshot = await self._method("ref", (ref,), {})
                return _Element(snapshot) if isinstance(snapshot, dict) else None

            return _LazyElement({"ref": ref}, None, resolve)

        async def run(self, code, *, read_only=None, timeout=None):
            """Run a JavaScript code string in the persistent desktop session and return its value."""
            if not isinstance(code, str):
                raise TypeError("computer.run() expects a JavaScript code string")
            details = await _invoke(
                "run",
                {"code": code, "read_only": read_only, "timeout": timeout},
            )
            return details.get("value")

        async def capabilities(self):
            """Initialize the desktop and return backend capabilities and permission state."""
            return await self._method("capabilities", (), {})

        async def help(self):
            """Print the typed computer API: every interface and signature the handles expose."""
            await _invoke("help", {})

        async def release(self):
            """Drain and release capture/control resources; later calls start a fresh desktop worker."""
            await _invoke("release", {})

        async def close(self):
            """End the persistent desktop session; later calls fail."""
            await _invoke("close", {})

    return _Computer()


computer = _make_computer()
del _make_computer
