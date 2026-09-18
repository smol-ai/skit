import {
  LibraryManifest as CoreLibraryManifest,
  libraryResponseSchema,
  libraryWriteRequestSchema,
} from "@smolai/skit-core/universal/consumer";

export const LibraryManifest = CoreLibraryManifest;
export type LibraryManifest = typeof LibraryManifest.Type;
export const LibraryWriteRequest = libraryWriteRequestSchema;
export type LibraryWriteRequest = typeof LibraryWriteRequest.Type;
export const Library = libraryResponseSchema.fields.library;
export type Library = typeof Library.Type;
export const LibraryResponse = libraryResponseSchema;
