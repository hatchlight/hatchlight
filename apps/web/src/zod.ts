import { config } from "zod";

// zod checks once whether it may compile its parsers with `new Function`.
// A server's content security policy forbids that, so the check fails and
// zod parses the plain way, which works; but the browser still reports the
// attempt as a policy violation. In the browser, skip the check and the
// compiling. The server and the command line keep both.
config({ jitless: true });
