import "./fluid-utilities.css";
import "./fluid/theme.css";
import "./fonts.css";
import { Http, Runtime } from "foldkit";
import { Message, Model } from "./model.ts";
import { init, subscriptions, update, view } from "./main.ts";

Runtime.run(
  Runtime.makeApplication({
    Model,
    init,
    update,
    view,
    subscriptions,
    container: document.getElementById("root"),
    routing: {
      onUrlRequest: (request) => Message.ClickedLink({ request }),
      onUrlChange: (url) => Message.ChangedUrl({ url }),
    },
    resources: Http.layer,
    devTools: { Message },
  }),
);
