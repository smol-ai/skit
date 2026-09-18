# Separate portable library intent from device state

SKIT keeps portable Library Entries and Bindings separate from device-local Projection and Custody evidence. A Library Manifest can contain relative locators and expected content digests, but it does not contain absolute projection paths, ownership markers, observations, drift, conflicts, journals, or tombstones; this prevents one device's filesystem state from becoming another device's desired state.
