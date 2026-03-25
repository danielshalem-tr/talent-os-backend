import { Injectable } from '@nestjs/common';

@Injectable()
export class AppConfigService {
  getConfig() {
    return {
      departments: [
        'Engineering',
        'Product',
        'Design',
        'Marketing',
        'HR',
      ],
      hiring_managers: [
        { id: 'mgr-1', name: 'Jane Smith' },
        { id: 'mgr-2', name: 'Admin Cohen' },
      ],
      job_types: [
        { id: 'full_time', label: 'Full Time' },
        { id: 'part_time', label: 'Part Time' },
        { id: 'contract', label: 'Contract' },
      ],
      organization_types: [
        { id: 'startup', label: 'Startup' },
        { id: 'scale_up', label: 'Scale-up' },
        { id: 'enterprise', label: 'Enterprise' },
        { id: 'nonprofit', label: 'Nonprofit' },
        { id: 'government', label: 'Government' },
      ],
      screening_question_types: [
        { id: 'yes_no', label: 'Yes / No' },
        { id: 'text', label: 'Free Text' },
      ],
      hiring_stages_template: [
        {
          name: 'Application review',
          is_enabled: true,
          color: 'bg-zinc-400',
          is_custom: false,
          order: 1,
        },
        {
          name: 'Screening',
          is_enabled: true,
          color: 'bg-blue-500',
          is_custom: false,
          order: 2,
        },
        {
          name: 'Interview',
          is_enabled: true,
          color: 'bg-indigo-400',
          is_custom: false,
          order: 3,
        },
        {
          name: 'Offer',
          is_enabled: true,
          color: 'bg-emerald-500',
          is_custom: false,
          order: 4,
        },
      ],
    };
  }
}
