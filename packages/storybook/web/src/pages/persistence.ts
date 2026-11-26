import type { HtmlBuilder } from "foldkit/html";
import type { Atlas, PersistedStore } from "../../../src/atlas/data.ts";
import * as PageHeader from "../components/page-header.ts";
import * as Item from "../components/item.ts";
import * as DataList from "../components/data-list.ts";
import * as Accordion from "../fluid/components/accordion";
import * as Input from "../fluid/components/input";
import { icon } from "../fluid/components/icons";
import { Message, type Model } from "../model.ts";
import { errorHref, storeHref, serviceHref } from "../route.ts";

const metadata = (store: PersistedStore) =>
  `${store.scope} | ${store.format} | Owner: ${store.owner}`;

export function persistencePage(atlas: Atlas, model: Model, h: HtmlBuilder<Message>) {
  const query = model.persistenceQuery.trim().toLowerCase();
  const stores = atlas.persistence.filter((store) =>
    [
      store.name,
      metadata(store),
      store.description,
      ...store.paths,
      ...store.definitions.map(
        (definition) => `${definition.name} ${definition.file} ${definition.source}`,
      ),
    ]
      .join("\n")
      .toLowerCase()
      .includes(query),
  );
  return h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view(
        {
          title: ["Persisted data"],
          description: [
            "SKIT's saved formats, paths and owners, with definitions read from this checkout when Atlas is generated. <home> is SKIT_HOME (default ~/.skit). Workspace paths include global and repository skills directories. This is a format reference; it does not read your saved data. External harness stores are outside this catalog.",
          ],
        },
        h,
      ),
      h.div(
        [h.Class("grid min-w-0 gap-3")],
        [
          Input.view(
            {
              id: "persistence-query",
              type: "search",
              ariaLabel: "Search persisted data",
              placeholder: "Search paths, owners, tables and fields",
              value: model.persistenceQuery,
              onInput: (query) => Message.ChangedPersistenceQuery({ query }),
            },
            h,
          ),
          h.p(
            [h.Class("m-0 text-caption text-muted-foreground")],
            [`${stores.length} of ${atlas.persistence.length} stores`],
          ),
          ...(stores.length ? [] : [h.p([h.Class("m-0")], ["No persisted data matches."])]),
        ],
      ),
      Item.group(
        {
          label: "Persisted stores",
          items: stores.map((store) => ({
            key: store.id,
            title: [store.name],
            description: [store.description],
            href: storeHref(store.id),
            size: "compact",
            metadata: [
              h.div(
                [h.Class("grid min-w-0 gap-1")],
                store.paths.map((path) =>
                  h.code([h.Key(path), h.Class("font-mono break-words")], [path]),
                ),
              ),
            ],
            trailing: [
              h.span(
                [h.Class("max-w-prose text-right text-caption text-muted-foreground")],
                [metadata(store)],
              ),
              icon("chevron-right", undefined, h, { className: "size-4 text-muted-foreground" }),
            ],
          })),
        },
        h,
      ),
    ],
  );
}

/** The owner and definition source IDs also constrain Accordion updates. */
export const storeDisclosures = (
  store: PersistedStore,
): Array<{ value: string; label: string; source: string; file?: string }> => [
  ...store.owners.map((owner, index) => ({
    value: `owner-${index}`,
    label: `${owner.file}:${owner.line} — ${owner.name}`,
    source: owner.source,
  })),
  ...store.definitions.map((definition, index) => ({
    value: `definition-${index}`,
    label: definition.name,
    file: `${definition.file}:${definition.line}`,
    source: definition.source,
  })),
];

export function persistedStorePage(
  atlas: Atlas,
  store: PersistedStore,
  model: Model,
  h: HtmlBuilder<Message>,
) {
  const disclosures = storeDisclosures(store);
  const accordion = (id: string, items: typeof disclosures) =>
    h.submodel({
      slotId: id,
      model: model.detailDisclosures,
      view: Accordion.view,
      toParentMessage: (message) => Message.DetailDisclosures({ message }),
      viewInputs: {
        id,
        type: "multiple",
        className: "w-full!",
        items,
        renderContent: (value) => {
          const item = items.find((item) => item.value === value)!;
          return h.div(
            [h.Class("grid min-w-0 gap-3")],
            [
              ...("file" in item && item.file !== undefined
                ? [
                    h.p(
                      [h.Class("m-0 text-caption text-muted-foreground")],
                      [h.code([h.Class("font-mono")], [item.file])],
                    ),
                  ]
                : []),
              h.pre(
                [h.Class("m-0 max-h-96 overflow-auto bg-muted p-4 text-caption")],
                [h.code([h.Class("font-mono")], [item.source])],
              ),
            ],
          );
        },
      },
    });
  return h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view(
        {
          title: [store.name],
          description: [store.description],
          children: [
            DataList.view(
              {
                label: "Store facts",
                items: [
                  { key: "scope", label: ["Scope"], value: [store.scope] },
                  { key: "format", label: ["Format"], value: [store.format] },
                  { key: "owner", label: ["Owner"], value: [store.owner] },
                ],
              },
              h,
            ),
          ],
        },
        h,
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Storage paths"]),
          DataList.view(
            {
              label: "Storage paths",
              orientation: "vertical",
              items: store.paths.map((path, index) => ({
                key: path,
                label: [`Path ${index + 1}`],
                value: [h.code([h.Class("font-mono text-foreground")], [path])],
              })),
            },
            h,
          ),
        ],
      ),
      h.section(
        [h.Class("grid min-w-0 gap-4")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Owners in code"]),
          h.p(
            [h.Class("m-0 max-w-prose text-muted-foreground")],
            [
              "Ownership is curated and resolved against exported symbols at generation. Some formats have several owners. Error links describe the owner’s interface, not proof that a command accesses this store.",
            ],
          ),
          ...store.owners.map((owner, index) =>
            h.section(
              [h.Key(`${owner.file}/${owner.name}`), h.Class("grid min-w-0 gap-3")],
              [
                accordion(`store-owner-${index}`, [disclosures[index]!]),
                ...atlas.systemMap.services
                  .filter(
                    (service) =>
                      service.kind === "Owner" &&
                      service.stores.includes(store.id) &&
                      service.name === owner.name &&
                      service.file === owner.file,
                  )
                  .map((service) =>
                    Item.group(
                      {
                        label: "Declared owner",
                        items: [
                          {
                            key: service.id,
                            title: [service.name],
                            href: serviceHref(service.id),
                            size: "compact",
                            trailing: [
                              icon("chevron-right", undefined, h, {
                                className: "size-4 text-muted-foreground",
                              }),
                            ],
                          },
                        ],
                      },
                      h,
                    ),
                  ),
                owner.errors.length
                  ? Item.group(
                      {
                        label: `Errors declared by ${owner.name}`,
                        items: owner.errors.map((key) => ({
                          key,
                          title: [
                            atlas.errors.find((error) => `${error.file}/${error.name}` === key)
                              ?.name ?? key,
                          ],
                          href: errorHref(key),
                          size: "compact",
                          trailing: [
                            icon("chevron-right", undefined, h, {
                              className: "size-4 text-muted-foreground",
                            }),
                          ],
                        })),
                      },
                      h,
                    )
                  : h.p(
                      [h.Class("m-0 text-muted-foreground")],
                      ["No SKIT errors catalogued for this symbol’s interface."],
                    ),
              ],
            ),
          ),
        ],
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Source definitions"]),
          h.p(
            [h.Class("m-0 max-w-prose")],
            [
              "Exact source from the checkout used to generate Atlas. Imported names refer to their owning modules; definitions include format versions and compatibility code where applicable.",
            ],
          ),
          accordion("store-definitions", disclosures.slice(store.owners.length)),
        ],
      ),
    ],
  );
}
