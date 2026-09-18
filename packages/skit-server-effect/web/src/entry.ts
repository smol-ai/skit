import { Runtime } from "foldkit";
import { Flags, Message, Model, init, subscriptions, update, view } from "./main.ts";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById("root"),
  devTools: { Message },
});

Runtime.hydrate(application, { buildId: import.meta.env.FOLDKIT_BUILD_ID });
