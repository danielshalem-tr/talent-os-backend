import { Injectable } from '@nestjs/common';

@Injectable()
export class AppConfigService {
  getConfig() {
    return {
      departments: ['Engineering', 'Product', 'Design', 'Marketing', 'HR', 'Sales'],
      hiring_managers: [
        { id: 'mgr-1', name: 'Yuval Bar Or' },
        { id: 'mgr-2', name: 'Asaf Bar Or' },
        { id: 'mgr-3', name: 'Raanan Sucary' },
      ],
      job_types: [
        { id: 'full_time', label: 'Full Time' },
        { id: 'part_time', label: 'Part Time' },
        { id: 'contract', label: 'Contract' },
      ],
      organization_types: [
        { id: 'startup', label: 'Startup' },
        { id: 'enterprise', label: 'Corporate / Enterprise' },
        { id: 'agency', label: 'Agency' },
        { id: 'nonprofit', label: 'Non-profit' },
      ],
      screening_question_types: [
        { id: 'yes_no', label: 'Yes / No' },
        { id: 'text', label: 'Free Text' },
      ],
      hiring_stages_template: [
        { name: 'Application Review', is_enabled: true, color: 'bg-zinc-400', is_custom: false, order: 1 },
        { name: 'Screening', is_enabled: true, color: 'bg-blue-500', is_custom: false, order: 2 },
        { name: 'Interview', is_enabled: true, color: 'bg-indigo-400', is_custom: false, order: 3 },
        { name: 'Offer', is_enabled: true, color: 'bg-emerald-500', is_custom: false, order: 4 },
        { name: 'Hired', is_enabled: false, color: 'bg-green-600', is_custom: false, order: 5 },
        { name: 'Rejected', is_enabled: false, color: 'bg-red-500', is_custom: false, order: 6 },
        { name: 'Pending Decision', is_enabled: false, color: 'bg-yellow-400', is_custom: false, order: 7 },
        { name: 'On Hold', is_enabled: false, color: 'bg-gray-500', is_custom: false, order: 8 },
      ],
    };
  }
}
