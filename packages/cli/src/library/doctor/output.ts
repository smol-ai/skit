import { DoctorReport } from "@smolai/skit-core/library/inventory";

export const doctorOutputContracts = {
  doctor: { id: "skit.doctor.v10", schema: DoctorReport },
} as const;
