import { DoctorReport } from "./harnesses.js";

export const doctorOutputContracts = {
  doctor: { id: "skit.doctor.v10", schema: DoctorReport },
} as const;
