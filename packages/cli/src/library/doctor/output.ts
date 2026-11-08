import { DoctorReport } from "@smolai/skit-core/library/inventory";

export const doctorOutputContracts = {
  doctor: { id: "skit.doctor.v8", schema: DoctorReport },
} as const;
